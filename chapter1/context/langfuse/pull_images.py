#!/usr/bin/env python3
"""Pull pinned Compose images through the host proxy without restarting Docker.

Archives, image storage and digests are kept on the data disk. The shared Docker
daemon is left unchanged; images are loaded into the dedicated rootless daemon.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tarfile

ROOT = Path('/disk1/langfuse')
CRANE = ROOT / 'bin/crane'
DOCKER = ['docker', '--host', f'unix:///run/user/{os.getuid()}/langfuse-docker.sock']
IMAGES = [
    'docker.langfuse.com/langfuse/langfuse:4.66.0',
    'docker.langfuse.com/langfuse/langfuse-worker:4.66.0',
    'docker.io/postgres:17-alpine',
    'docker.io/redis:7-alpine',
    'docker.io/clickhouse/clickhouse-server:25.12',
    'cgr.dev/chainguard/minio:latest',
]


def expanded_size(path):
    total = 0
    with tarfile.open(path) as archive:
        for member in archive.getmembers():
            if member.isfile() and (member.name.endswith('.tar.gz') or member.name.endswith('/layer.tar')):
                stream = archive.extractfile(member)
                if stream.read(2) == b'\x1f\x8b':
                    stream.seek(member.size - 4)
                    total += struct.unpack('<I', stream.read(4))[0]
                else:
                    total += member.size
    if not total:
        raise RuntimeError('Could not determine expanded image size')
    return total


def main():
    actual_root = subprocess.check_output(DOCKER + ['info', '--format', '{{.DockerRootDir}}'], text=True).strip()
    if actual_root != str(ROOT / 'docker-data'):
        raise RuntimeError('Expected the dedicated data-disk Docker daemon')
    env = {**os.environ, 'HTTP_PROXY': 'http://127.0.0.1:18080',
           'HTTPS_PROXY': 'http://127.0.0.1:18080', 'NO_PROXY': 'localhost,127.0.0.1'}
    old_receipts = {item['image']: item for item in json.loads((ROOT / 'image-receipt.json').read_text())} if (ROOT / 'image-receipt.json').exists() else {}
    cached = {}
    for archive_path in (ROOT / 'images').glob('*.tar'):
        with tarfile.open(archive_path) as archive:
            descriptors = json.load(archive.extractfile('manifest.json'))
            for descriptor in descriptors:
                config_bytes = archive.extractfile(descriptor['Config']).read()
                config_digest = 'sha256:' + hashlib.sha256(config_bytes).hexdigest()
                if descriptor['Config'].removesuffix('.json') != config_digest.removeprefix('sha256:'):
                    raise RuntimeError('Cached archive configuration digest mismatch')
                for tag in descriptor.get('RepoTags', []):
                    cached[tag.removeprefix('docker.io/')] = (archive_path, config_digest)
    receipts = []
    for image in IMAGES:
        print('Preparing:', image, flush=True)
        if image.removeprefix('docker.io/') in cached:
            path, expected_config = cached[image.removeprefix('docker.io/')]
            previous = old_receipts.get(image, {})
            digest = previous.get('digest')
            if previous.get('config_digest', expected_config) != expected_config:
                raise RuntimeError('Cached configuration differs from the verified receipt')
            print('Using previously downloaded archive:', path.name, flush=True)
        else:
            digest = subprocess.check_output([str(CRANE), 'digest', '--platform', 'linux/amd64', image], env=env, text=True).strip()
            ref = image.rsplit(':', 1)[0] + '@' + digest
            manifest = json.loads(subprocess.check_output([str(CRANE), 'manifest', '--platform', 'linux/amd64', ref], env=env, text=True))
            expected_config = manifest['config']['digest']
            path = ROOT / 'images' / (hashlib.sha256(ref.encode()).hexdigest()[:16] + '.tar')
            partial = path.with_suffix('.partial')
            subprocess.run([str(CRANE), 'pull', '--platform', 'linux/amd64', '--format', 'legacy', image, str(partial)], env=env, check=True)
            partial.rename(path)
        required = expanded_size(path)
        free = shutil.disk_usage(ROOT).free
        print('Expanded image bytes:', required, 'Data disk free:', free, flush=True)
        exists = subprocess.run(DOCKER + ['image', 'inspect', image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        if not exists:
            # containerd keeps both imported content and unpacked snapshots.
            if free < required + path.stat().st_size + 1536 * 1024**2:
                raise RuntimeError('Insufficient data disk space with 1.5 GiB reserve; refusing image load')
            subprocess.run(DOCKER + ['load', '--input', str(path)], check=True)
        with tarfile.open(path) as archive:
            archive_manifest = json.load(archive.extractfile('manifest.json'))
            config_bytes = archive.extractfile(archive_manifest[0]['Config']).read()
        if 'sha256:' + hashlib.sha256(config_bytes).hexdigest() != expected_config:
            raise RuntimeError('Archive config does not match pinned registry digest')
        expected = json.loads(config_bytes)
        actual = json.loads(subprocess.check_output(DOCKER + ['image', 'inspect', image], text=True))[0]
        # Docker's containerd image store may expose a translated manifest ID
        # rather than the registry config ID. Check the actual layer diff IDs
        # and runtime configuration in addition to the exact archive digest.
        if actual['RootFS']['Layers'] != expected['rootfs']['diff_ids'] or actual['Architecture'] != expected['architecture'] or actual['Os'] != expected['os']:
            raise RuntimeError('Loaded image platform or layer contents differ from the pinned archive')
        for key in ['Env', 'Entrypoint', 'Cmd', 'WorkingDir', 'User', 'Labels']:
            if actual['Config'].get(key) != expected['config'].get(key):
                raise RuntimeError('Loaded image runtime configuration differs: ' + key)
        receipts.append({'image': image, 'digest': digest, 'config_digest': expected_config, 'docker_image_id': actual['Id'], 'archive': str(path), 'expanded_bytes': required})
        (ROOT / 'image-receipt.json').write_text(json.dumps(receipts, indent=2) + '\n')


if __name__ == '__main__':
    main()

"""Keep dependency exceptions limited to reviewed, non-secret production paths."""
import hashlib
import json
from pathlib import Path
import subprocess

SSO_SOURCE_SHA256 = '305a15e6da43aba8e94a2a9b13db8833a1269d1ad81084e4edb724391bf3725d'


def verify(metadata):
    packages = {p['id']: (p['name'], p['version']) for p in metadata['packages']}
    rsa_ids = {key for key, value in packages.items() if value[0] == 'rsa'}
    if {packages[key] for key in rsa_ids} != {('rsa', '0.9.10')}:
        raise ValueError('Re-review the RSA version and remove obsolete exceptions')
    parents = set()
    for node in metadata['resolve']['nodes']:
        for dep in node['deps']:
            if dep['pkg'] in rsa_ids and any(kind['kind'] != 'dev' for kind in dep['dep_kinds']):
                parents.add(packages[node['id']])
    if parents != {('openidconnect', '4.1.0')}:
        raise ValueError('RSA now has an unreviewed production consumer')
    if hashlib.sha256(Path('crates/server/src/sso.rs').read_bytes()).hexdigest() != SSO_SOURCE_SHA256:
        raise ValueError('Authentication changed; re-review its public-verification-only RSA use')


if __name__ == '__main__':
    sqlite = subprocess.check_output(['cargo', 'tree', '--locked', '--all-features', '--target', 'all', '-e', 'normal,build', '-i', 'libsqlite3-sys'], text=True)
    if sqlite.strip():
        raise ValueError('SQLite is now compiled; remove its audit exception')
    metadata = subprocess.check_output(['cargo', 'metadata', '--locked', '--format-version=1'], text=True)
    verify(json.loads(metadata))
    print('Reviewed unused-SQLite and public-signature-only RSA paths are unchanged.')

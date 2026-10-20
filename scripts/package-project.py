"""Create a portable project handoff using Python's standard library only."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
output = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root.parent / 'Next-Man-Project-Handoff-2026-10-20.zip'
if output == root or root in output.parents:
    raise SystemExit('Write the ZIP outside the project to avoid packaging itself.')
source_dirs = {'public', 'lib', 'scripts', 'data', 'reports', 'test', 'docs', 'dist', '.openai'}
cache_dirs = {'injury-history', 'walk-forward', 'real-data', 'validation', 'candidate', 'forward-ledger'}
cache_files = {'player_stats_2023.csv', 'player_stats_2024.csv'}
root_files = {'README.md', 'package.json', '.gitignore', '.env.example'}
files = []
for p in sorted(root.rglob('*')):
    if not p.is_file() or p.is_symlink():
        continue
    relative = p.relative_to(root)
    parts = relative.parts
    include = (len(parts) == 1 and p.name in root_files) or parts[0] in source_dirs
    if parts[0] == '.cache' and len(parts) > 1:
        include = parts[1] in cache_dirs or (len(parts) == 2 and parts[1] in cache_files)
    if not include:
        continue
    if any(part in {'.git', 'node_modules', '__pycache__', '.sites-runtime'} for part in parts):
        continue
    if p.name == '.env' or (p.name.startswith('.env.') and p.name != '.env.example'):
        raise SystemExit('Refusing to package environment secrets.')
    if p.suffix.lower() in {'.pem', '.key', '.p12', '.pfx'}:
        raise SystemExit('Refusing to package a credential file.')
    files.append((p, relative.as_posix()))

manifest = {
    'createdAt': datetime.now(timezone.utc).isoformat(),
    'project': 'Next Man NFL Pregame Injury Model',
    'version': '0.4.0 local handoff; not deployed',
    'lastPublishedSourceCommit': '836a95ac48df4dc8af0f370f53913e4af4db7a07',
    'modelReadiness': 'Not predictively validated; no approved betting markets',
    'excluded': ['Git internals', 'credentials and actual environment files', 'machine runtime state', 'prior release archives', 'disposable test and smoke outputs'],
    'files': [{'path': name, 'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p, name in files],
}
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for p, name in files:
        archive.write(p, 'next-man/' + name)
    archive.writestr('next-man/ARCHIVE-MANIFEST.json', json.dumps(manifest, indent=2) + '\n')
digest = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix(output.suffix + '.sha256').write_text(digest + '  ' + output.name + '\n', encoding='utf-8')
print(json.dumps({'archive': str(output), 'files': len(files) + 1, 'bytes': output.stat().st_size, 'uncompressedBytes': sum(p.stat().st_size for p, _ in files), 'sha256': digest}, indent=2))

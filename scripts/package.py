"""Package the built extension, using only the Python standard library."""
import hashlib
import json
from pathlib import Path
import re
import zipfile

root = Path(__file__).resolve().parent.parent
dist = root / 'dist'
manifest = json.loads((dist / 'manifest.json').read_text())
version = manifest['version']
if not re.fullmatch(r'\d+\.\d+\.\d+', version):
    raise SystemExit('Invalid release version')
if json.loads((root / 'package.json').read_text())['version'] != version:
    raise SystemExit('package.json and manifest.json versions differ')

required = {
    'manifest.json', 'content.js', 'background.js', 'panel.js', 'options.js',
    'panel.html', 'options.html', 'styles.css', 'icon.svg', 'init_icon.svg',
    'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png',
    'THIRD_PARTY_NOTICES.md', 'licenses/readability-Apache-2.0.txt',
}
files = {p.relative_to(dist).as_posix(): p for p in dist.rglob('*') if p.is_file()}
if files.keys() != required or any(p.is_symlink() for p in files.values()):
    raise SystemExit(f'Unexpected build contents: missing={required-files.keys()}, extra={files.keys()-required}')

folder = f'pagewise-chrome-{version}'
out = root / 'releases'
out.mkdir(exist_ok=True)
archive = out / f'{folder}.zip'
instructions = f'''佩知 · Pagewise {version}

1. 解压后，将 {folder} 文件夹放到固定位置。
2. 在 Chrome 中打开 chrome://extensions，开启开发者模式。
3. 点击“加载已解压的扩展程序”，选择包含 manifest.json 的这个文件夹。
4. 刷新网页，点击小企鹅，在设置里填写 API Key。

更新时替换原来加载目录内的文件，再在扩展管理页重新加载并刷新网页。
说明与源码：https://github.com/MiracleZeroPenguin/pagewise-chrome
'''
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    contents = {name: p.read_bytes() for name, p in files.items()}
    contents['INSTALL.txt'] = instructions.encode('utf-8')
    for name, data in sorted(contents.items()):
        info = zipfile.ZipInfo(f'{folder}/{name}', date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        z.writestr(info, data, compresslevel=9)
with zipfile.ZipFile(archive) as z:
    if z.testzip() is not None:
        raise SystemExit('ZIP integrity check failed')
    assert json.loads(z.read(f'{folder}/manifest.json')) == manifest
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(out / f'{folder}.sha256').write_text(f'{digest}  {archive.name}\n')
print(f'{archive.name}: {archive.stat().st_size:,} bytes\nSHA-256: {digest}')

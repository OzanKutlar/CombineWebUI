"""Downloads the browser libraries index.html uses into pages/static/vendor/.

Run it once, with internet access: python scripts/fetch_vendor.py
Afterwards the page loads without any, in desktop mode and in the browser.
Existing files are kept unless --force is given.
"""
import argparse
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR_DIR = ROOT / 'pages' / 'static' / 'vendor'
TIMEOUT_SECONDS = 60
MAX_BYTES = 10 * 1024 * 1024
USER_AGENT = 'CombineWebUI-vendor-fetch/1.0'
LIBRARIES = (
    ('tailwindcss.js', 'https://cdn.tailwindcss.com?plugins=typography'),
    ('lucide.js', 'https://unpkg.com/lucide@latest'),
    ('marked.min.js', 'https://cdn.jsdelivr.net/npm/marked/marked.min.js'),
    ('purify.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.6/purify.min.js'),
)
SSL_HINT = ('  hint: for a certificate error on macOS with the python.org installer, run '
            'Install Certificates.command from its Applications folder and try again.')


def download(url):
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        status = getattr(response, 'status', 200)
        if status != 200:
            raise RuntimeError(f'HTTP {status}')
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise RuntimeError(f'the file is larger than {MAX_BYTES:,} bytes')
    if not data.strip() or data.lstrip()[:1] == b'<':
        raise RuntimeError('the response is not JavaScript')
    return data


def write_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=str(path.parent))
    try:
        with os.fdopen(handle, 'wb') as f:
            f.write(data)
        os.replace(temp, path)
    except OSError:
        try:
            os.remove(temp)
        except OSError as cleanup_error:
            print(f'  could not remove {temp}: {cleanup_error}')
        raise


def fetch_one(name, url, force):
    target = VENDOR_DIR / name
    if target.exists() and not force:
        print(f'  kept     {name} (already present; --force replaces it)')
        return True
    try:
        data = download(url)
        write_atomic(target, data)
    except (urllib.error.URLError, OSError, RuntimeError, ValueError) as e:
        print(f'  FAILED   {name}: {e}')
        if 'CERTIFICATE' in str(e).upper():
            print(SSL_HINT)
        return False
    print(f'  fetched  {name} ({len(data):,} bytes)')
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description='Download local copies of the browser libraries.')
    parser.add_argument('--force', action='store_true', help='Replace files that are already present')
    args = parser.parse_args(argv)
    print(f'Writing to {VENDOR_DIR}')
    results = [fetch_one(name, url, args.force) for name, url in LIBRARIES]
    if all(results):
        print('Done. The page now loads without internet access.')
        return 0
    print(f'{results.count(False)} download(s) failed; the page uses the CDN for those.')
    return 1


if __name__ == '__main__':
    sys.exit(main())

"""Recalculate an actual public-action download with LibreOffice; never alter its source."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('workbook', type=Path)
parser.add_argument('--soffice', default='/Applications/LibreOffice.app/Contents/MacOS/soffice' if Path('/Applications/LibreOffice.app/Contents/MacOS/soffice').exists() else shutil.which('soffice'))
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
engine = args.soffice
if not engine:
    raise SystemExit('LibreOffice soffice is required')
namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
ET.register_namespace('', namespace)
q = lambda name: '{' + namespace + '}' + name
results = []
cases = [
    ('confirmed', None, '244.85', '贰佰肆拾肆元捌角伍分'),
    ('changed', ['123.46', '10.20', '20.30', '40.40', '50.50'], '244.86', '贰佰肆拾肆元捌角陆分'),
    ('zero', ['0', '0', '0', '0', '0'], '0', '零元整'),
    ('fen', ['0.05', '0', '0', '0', '0'], '0.05', '零元伍分'),
    ('jiao', ['0.50', '0', '0', '0', '0'], '0.5', '零元伍角'),
    ('missing-jiao', ['10.01', '0', '0', '0', '0'], '10.01', '壹拾元零壹分'),
    ('missing-fen', ['100.10', '0', '0', '0', '0'], '100.1', '壹佰元壹角'),
    ('carry', ['99.99', '0.01', '0', '0', '0'], '100', '壹佰元整'),
]
with tempfile.TemporaryDirectory(prefix='summary-native-') as temporary:
    root = Path(temporary)
    for name, inputs, total, uppercase in cases:
        source = root / (name + '.xlsx')
        with zipfile.ZipFile(args.workbook) as original, zipfile.ZipFile(source, 'w', zipfile.ZIP_DEFLATED) as output:
            for part in original.namelist():
                payload = original.read(part)
                if part == 'xl/worksheets/sheet1.xml':
                    sheet = ET.fromstring(payload)
                    if inputs:
                        for address, value in zip(['F6', 'F7', 'F8', 'K6', 'F9'], inputs):
                            cell = sheet.find('.//' + q('c') + '[@r="' + address + '"]')
                            cell.find(q('v')).text = value
                    for cell in sheet.findall('.//' + q('c')):
                        if cell.find(q('f')) is not None:
                            cached = cell.find(q('v'))
                            if cached is not None:
                                cell.remove(cached)
                    payload = ET.tostring(sheet, encoding='utf-8', xml_declaration=True)
                output.writestr(part, payload)
        destination = args.output / name
        destination.mkdir(exist_ok=True)
        subprocess.run([engine, '-env:UserInstallation=' + (root / 'profile').as_uri(), '--headless', '--convert-to', 'xlsx', '--outdir', str(destination), str(source)], check=True, capture_output=True)
        with zipfile.ZipFile(destination / source.name) as calculated:
            sheet = ET.fromstring(calculated.read('xl/worksheets/sheet1.xml'))
            strings = [''.join(item.itertext()) for item in ET.fromstring(calculated.read('xl/sharedStrings.xml'))] if 'xl/sharedStrings.xml' in calculated.namelist() else []
            values = {}
            for address in ['D17', 'B18']:
                cell = sheet.find('.//' + q('c') + '[@r="' + address + '"]')
                value = cell.find(q('v')).text
                values[address] = strings[int(value)] if cell.get('t') == 's' else value
            assert values == {'D17': total, 'B18': uppercase}, (name, values)
            results.append({'case': name, **values})
    subprocess.run([engine, '-env:UserInstallation=' + (root / 'profile').as_uri(), '--headless', '--convert-to', 'pdf', '--outdir', str(args.output), str(args.workbook)], check=True, capture_output=True)
(args.output / 'recalculation.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
print(subprocess.check_output([engine, '--version'], text=True).strip())
print(json.dumps(results, ensure_ascii=False))

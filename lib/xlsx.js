/**
 * Minimal XLSX writer: one sheet, inline strings, stored (uncompressed) ZIP
 * entries. Excel, LibreOffice and pandas all read this; it exists so the plugin
 * exports a real workbook without adding a dependency.
 * @module dsh-literature/xlsx
 */
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let value = i;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) !== 0 ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[i] = value;
    }
    return table;
})();

function crc32(buffer) {
    let crc = ~0;
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (~crc) >>> 0;
}

/** A stored-or-deflated ZIP archive with a UTF-8 name flag. */
function zip(entries) {
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
        const deflated = deflateRawSync(raw);
        const useDeflate = deflated.length < raw.length;
        const data = useDeflate ? deflated : raw;
        const method = useDeflate ? 8 : 0;
        const crc = crc32(raw);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        chunks.push(local, name, data);

        const head = Buffer.alloc(46);
        head.writeUInt32LE(0x02014b50, 0);
        head.writeUInt16LE(20, 4);
        head.writeUInt16LE(20, 6);
        head.writeUInt16LE(0x0800, 8);
        head.writeUInt16LE(method, 10);
        head.writeUInt16LE(0, 12);
        head.writeUInt16LE(0, 14);
        head.writeUInt32LE(crc, 16);
        head.writeUInt32LE(data.length, 20);
        head.writeUInt32LE(raw.length, 24);
        head.writeUInt16LE(name.length, 28);
        head.writeUInt16LE(0, 30);
        head.writeUInt16LE(0, 32);
        head.writeUInt16LE(0, 34);
        head.writeUInt16LE(0, 36);
        head.writeUInt32LE(0, 38);
        head.writeUInt32LE(offset, 42);
        central.push(head, name);

        offset += local.length + name.length + data.length;
    }
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...chunks, ...central, end]);
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        // Control characters are illegal in XML 1.0 and make Excel refuse the file.
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function columnName(index) {
    let name = '';
    let n = index + 1;
    while (n > 0) {
        const remainder = (n - 1) % 26;
        name = String.fromCharCode(65 + remainder) + name;
        n = Math.floor((n - 1) / 26);
    }
    return name;
}

function cell(ref, value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${ref}"><v>${value}</v></c>`;
    }
    if (typeof value === 'boolean') {
        return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

/**
 * Build a single-sheet workbook.
 * @param rows - array of arrays; the first row is treated as the header.
 * @param options - sheet name.
 * @returns the .xlsx bytes.
 */
export function buildXlsx(rows, options = {}) {
    const sheetName = (options.sheetName ?? 'Sheet1').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1';
    const widths = (options.widths ?? []).map((width) => `<col min="1" max="1" width="${width}" customWidth="1"/>`);
    const body = rows.map((row, rowIndex) => {
        const cells = row.map((value, columnIndex) => cell(`${columnName(columnIndex)}${rowIndex + 1}`, value)).join('');
        return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${widths.join('')}</cols><sheetData>${body}</sheetData></worksheet>`;
    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
    const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
    return zip([
        { name: '[Content_Types].xml', data: contentTypes },
        { name: '_rels/.rels', data: rootRels },
        { name: 'xl/workbook.xml', data: workbook },
        { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
        { name: 'xl/worksheets/sheet1.xml', data: sheet },
    ]);
}

"""Looking inside what a release publishes, binary or not.

Every file is searched byte for byte, whatever it is. Containers the scan can open are opened in
memory and their members searched the same way, as deep as they nest: zip, tar, gzip, bzip2 and xz,
PNG (its compressed text chunks and image stream) and icns (the images inside an icon). Nothing is
extracted to disk, so no member name can write outside the scan.

What cannot be opened cannot be searched, so it is not treated as clean. A file in a compressed or
encoded format the scan does not open (7z, RAR, zstd, an Apple disk image, ...) or any other
high-entropy data is a finding, unless its format is in ALLOWED_OPAQUE, which names each format
deliberately left closed (images, video, executables) and why. A container that is corrupt,
encrypted, nested too deep or would expand too far is a finding too.
"""
from __future__ import annotations

import bz2
import collections
import io
import lzma
import math
import re
import struct
import tarfile
import zipfile
import zlib
from dataclasses import dataclass, field
from typing import Iterator

# Formats the scan deliberately does not open, and why that hides nothing a person could read back.
# A format that is not here and cannot be opened fails the scan.
ALLOWED_OPAQUE = {
    'JPEG image': 'its entropy-coded data holds only pixel samples; comment, EXIF and XMP segments are '
                  'stored as plain bytes, and the whole file is searched byte for byte',
    'GIF image': 'its LZW data holds only pixel indices; comment and application extensions are stored as '
                 'plain bytes, and the whole file is searched byte for byte',
    'WebP image': 'its VP8/VP8L data holds only pixel samples; EXIF and XMP chunks are stored as plain bytes, '
                  'and the whole file is searched byte for byte',
    'JPEG 2000 image': 'its wavelet-coded data holds only pixel samples (macOS stores some icon sizes this way); '
                       'XML and UUID boxes are stored as plain bytes, and the whole file is searched byte for byte',
    'ISO media file': 'MP4, QuickTime, HEIC and AVIF hold coded video, audio and pixel samples; their metadata boxes '
                      '(udta, meta, XMP) are stored as plain bytes, and the whole file is searched byte for byte',
    'Matroska or WebM video': 'its blocks hold coded video and audio samples; tags and attachments are stored as plain '
                              'bytes, and the whole file is searched byte for byte',
    'Mach-O executable': 'machine code, symbol and string tables, embedded plists and the code signature are stored as '
                         'plain bytes, and the whole file is searched byte for byte. The main executable also carries '
                         'the frontend, which Tauri compresses into it (the whole file measures about 7.3 bits per '
                         'byte); that is built from '
                         "this repository's source and its locked packages, which are public, so no build-time "
                         'secret may ever be given to it (docs/RELEASING.md)',
    'ELF executable': 'machine code, symbol and string tables are stored as plain bytes, and the whole file is '
                      'searched byte for byte',
}

MAX_DEPTH = 8
# The most one top-level file may expand to across all of its nested members.
MAX_EXPANDED = 2 << 30
# Below this size, entropy says little; such a file is still searched byte for byte.
ENTROPY_MIN_BYTES = 4096
# Bits per byte above which data is taken to be compressed or encrypted (machine code and text sit
# well below; deflate, LZMA and ciphertext sit at ~7.9-8.0).
OPAQUE_ENTROPY = 7.5


@dataclass(frozen=True)
class Hit:
    where: str
    what: str
    # The matched bytes for a pattern or the home path, so that matches already published can be told
    # from new ones. None for this machine's own secrets (always reported) and for unopened content.
    match: bytes | None = None
    always: bool = True

    def finding(self) -> dict:
        return {'where': self.where, 'what': self.what}


class Unreadable(Exception):
    """A container that claims a format but cannot be read in full."""


def sniff(data: bytes) -> str | None:
    """The format of ``data`` by its magic bytes, or None for no format the scan knows."""
    if data.startswith(b'PK\x03\x04') or data.startswith(b'PK\x05\x06'):
        return 'zip archive'
    if data.startswith(b'\x1f\x8b'):
        return 'gzip stream'
    if data.startswith(b'BZh') and data[3:4] in b'123456789' and data[4:10] == b'1AY&SY':
        return 'bzip2 stream'
    if data.startswith(b'\xfd7zXZ\x00'):
        return 'xz stream'
    if data[257:262] == b'ustar':
        return 'tar archive'
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'PNG image'
    if data.startswith(b'icns') and len(data) >= 8 and struct.unpack('>I', data[4:8])[0] == len(data):
        return 'icns icon'
    if data.startswith(b'\xff\xd8\xff'):
        return 'JPEG image'
    if data.startswith(b'GIF87a') or data.startswith(b'GIF89a'):
        return 'GIF image'
    if data.startswith(b'RIFF') and data[8:12] == b'WEBP':
        return 'WebP image'
    if data.startswith(b'\x00\x00\x00\x0cjP  \r\n\x87\n') or data.startswith(b'\xff\x4f\xff\x51'):
        return 'JPEG 2000 image'
    if data.startswith(b"7z\xbc\xaf'\x1c"):
        return '7z archive'
    if data.startswith(b'Rar!\x1a\x07'):
        return 'RAR archive'
    if data.startswith(b'\x28\xb5\x2f\xfd'):
        return 'zstd stream'
    if data.startswith(b'\x04\x22\x4d\x18'):
        return 'LZ4 stream'
    if data.startswith(b'xar!'):
        return 'xar archive'
    if data.startswith(b'bvx2') or data.startswith(b'bvxn') or data.startswith(b'bvx-') or data.startswith(b'bvx1'):
        return 'LZFSE stream'
    if data.startswith(b'wOF2'):
        return 'WOFF2 font'
    if len(data) >= 512 and data[-512:-508] == b'koly':
        return 'Apple disk image'
    if _iso_media(data):
        return 'ISO media file'
    if data.startswith(b'\x1a\x45\xdf\xa3'):
        return 'Matroska or WebM video'
    if _mach_o(data):
        return 'Mach-O executable'
    if data.startswith(b'\x7fELF') and data[4:5] in (b'\x01', b'\x02') and data[5:6] in (b'\x01', b'\x02'):
        return 'ELF executable'
    return None


def _iso_media(data: bytes) -> bool:
    # The first box: a 32-bit size, then its type. ftyp names MP4, HEIC and AVIF; an older QuickTime
    # file may start straight at its movie or media data.
    if len(data) < 16 or data[4:8] not in (b'ftyp', b'moov', b'mdat', b'wide'):
        return False
    size = struct.unpack('>I', data[:4])[0]
    return size == 1 or 8 <= size <= len(data)


def _mach_o(data: bytes) -> bool:
    """A thin Mach-O whose load commands fit in the file, or a universal binary whose slices do."""
    if data[:4] in (b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe'):
        if len(data) < 28:
            return False
        filetype, ncmds, sizeofcmds = struct.unpack('<III', data[12:24])
        header = 32 if data[0] == 0xcf else 28
        return 1 <= filetype <= 12 and ncmds > 0 and header + sizeofcmds <= len(data)
    if data[:4] in (b'\xca\xfe\xba\xbe', b'\xca\xfe\xba\xbf'):
        # The same magic opens a Java class file, whose next four bytes are a version (45 or more);
        # a universal binary has a handful of slices.
        count = struct.unpack('>I', data[4:8])[0] if len(data) >= 8 else 0
        wide = data[3] == 0xbf
        entry = 32 if wide else 20
        if not 1 <= count <= 16 or 8 + count * entry > len(data):
            return False
        for index in range(count):
            at = 8 + index * entry
            if wide:
                offset, size = struct.unpack('>QQ', data[at + 8:at + 24])
            else:
                offset, size = struct.unpack('>II', data[at + 8:at + 16])
            if offset + size > len(data):
                return False
        return True
    return False


def entropy(data: bytes) -> float:
    counts = collections.Counter(data)
    total = len(data)
    return -sum(n / total * math.log2(n / total) for n in counts.values())


@dataclass
class Inspector:
    needles: dict[str, bytes]
    patterns: dict[str, bytes]
    hits: list[Hit] = field(default_factory=list)
    files: int = 0
    bytes: int = 0

    def inspect(self, where: str, data: bytes, *, extra: dict[str, bytes] | None = None, open_containers: bool = True) -> None:
        """Search ``data`` and, unless told not to, everything inside it."""
        self.files += 1
        budget = [MAX_EXPANDED]
        self._inspect(where, data, extra or {}, 0, budget, open_containers)

    def _search(self, where: str, data: bytes, extra: dict[str, bytes]) -> None:
        self.bytes += len(data)
        for what, value in self.needles.items():
            if value in data:
                self.hits.append(Hit(where, what))
        for what, value in extra.items():
            if value in data:
                self.hits.append(Hit(where, what, value, always=False))
        for what, pattern in self.patterns.items():
            for match in set(m.group(0) for m in re.finditer(pattern, data)):
                self.hits.append(Hit(where, what, match, always=False))

    def _inspect(self, where: str, data: bytes, extra: dict[str, bytes], depth: int, budget: list[int], open_containers: bool) -> None:
        self._search(where, data, extra)
        if not open_containers:
            return
        kind = sniff(data)
        opener = OPENERS.get(kind) if kind else None
        if opener is not None:
            if depth >= MAX_DEPTH:
                self.hits.append(Hit(where, f'{kind} nested more than {MAX_DEPTH} deep; the scan cannot look inside it'))
                return
            try:
                for name, member in opener(data, budget):
                    self._inspect(f'{where}!{name}', member, extra, depth + 1, budget, True)
            except Unreadable as error:
                self.hits.append(Hit(where, f'unreadable {kind} ({error}); the scan cannot look inside it'))
            return
        if kind in ALLOWED_OPAQUE:
            return
        if kind is not None:
            self.hits.append(Hit(where, f'{kind} the scan cannot open; add it to ALLOWED_OPAQUE with a reason, or do not publish it'))
            return
        if len(data) >= ENTROPY_MIN_BYTES and entropy(data) > OPAQUE_ENTROPY:
            self.hits.append(Hit(where, 'compressed or encrypted data in no format the scan knows; recognise its format in '
                                        'content.sniff() and either open it (OPENERS) or name it in ALLOWED_OPAQUE with a '
                                        'reason, or do not publish it'))


def _take(budget: list[int], size: int) -> None:
    budget[0] -= size
    if budget[0] < 0:
        raise Unreadable(f'it expands past {MAX_EXPANDED >> 30} GiB')


STEP = 1 << 24


def _inflate(decompressor, data: bytes, budget: list[int]) -> bytes:
    """Run a zlib decompressor over ``data`` to the end of its stream, within the budget."""
    out = []
    try:
        chunk = decompressor.decompress(data, STEP)
        while True:
            _take(budget, len(chunk))
            out.append(chunk)
            if decompressor.eof:
                break
            tail = decompressor.unconsumed_tail
            chunk = decompressor.decompress(tail, STEP)
            if not chunk and not tail:
                break
    except zlib.error as error:
        raise Unreadable(str(error)) from None
    if not decompressor.eof:
        raise Unreadable('the stream is truncated')
    return b''.join(out)


def _unpack(decompressor, data: bytes, budget: list[int]) -> bytes:
    """Run a bz2 or lzma decompressor over ``data`` to the end of its stream, within the budget."""
    out = []
    try:
        chunk = decompressor.decompress(data, STEP)
        while True:
            _take(budget, len(chunk))
            out.append(chunk)
            if decompressor.eof or decompressor.needs_input:
                break
            chunk = decompressor.decompress(b'', STEP)
    except (OSError, EOFError, ValueError, lzma.LZMAError) as error:
        raise Unreadable(str(error) or type(error).__name__) from None
    if not decompressor.eof:
        raise Unreadable('the stream is truncated')
    return b''.join(out)


def _gzip(data: bytes, budget: list[int]) -> Iterator[tuple[str, bytes]]:
    # A gzip file may hold several members back to back; each one is decompressed in turn.
    index = 0
    while data:
        decompressor = zlib.decompressobj(31)
        yield (f'gunzip#{index}' if index else 'gunzip'), _inflate(decompressor, data, budget)
        data = decompressor.unused_data.lstrip(b'\x00')
        index += 1


def _bzip2(data: bytes, budget: list[int]) -> Iterator[tuple[str, bytes]]:
    yield 'bunzip2', _unpack(bz2.BZ2Decompressor(), data, budget)


def _xz(data: bytes, budget: list[int]) -> Iterator[tuple[str, bytes]]:
    yield 'unxz', _unpack(lzma.LZMADecompressor(), data, budget)


def _tar(data: bytes, budget: list[int]) -> Iterator[tuple[str, bytes]]:
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
            for member in archive:
                if member.issym() or member.islnk():
                    # A link holds no data of its own, only its target's name.
                    yield f'{member.name} (link)', member.linkname.encode()
                elif member.isfile():
                    _take(budget, member.size)
                    handle = archive.extractfile(member)
                    yield member.name, handle.read() if handle else b''
    except tarfile.TarError as error:
        raise Unreadable(str(error)) from None


def _zip(data: bytes, budget: list[int]) -> Iterator[tuple[str, bytes]]:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for info in archive.infolist():
                if info.is_dir():
                    continue
                if info.flag_bits & 0x1:
                    raise Unreadable(f'{info.filename} is encrypted')
                _take(budget, info.file_size)
                yield info.filename, archive.read(info)
    except (zipfile.BadZipFile, zipfile.LargeZipFile, NotImplementedError, zlib.error, EOFError, OSError) as error:
        raise Unreadable(str(error) or type(error).__name__) from None


def _png(data: bytes, budget: list[int]) -> Iterator[tuple[str, bytes]]:
    position, image = 8, []
    while position + 8 <= len(data):
        length, kind = struct.unpack('>I4s', data[position:position + 8])
        body = data[position + 8:position + 8 + length]
        if len(body) != length:
            raise Unreadable(f'the {kind!r} chunk is truncated')
        position += 12 + length
        if kind == b'IDAT':
            image.append(body)
        elif kind == b'zTXt':
            keyword, _, rest = body.partition(b'\x00')
            yield f'zTXt {keyword.decode("latin-1")}', _inflate(zlib.decompressobj(), rest[1:], budget)
        elif kind == b'iTXt':
            keyword, _, rest = body.partition(b'\x00')
            if rest[:1] == b'\x01':
                text = rest[2:].split(b'\x00', 2)[-1]
                yield f'iTXt {keyword.decode("latin-1")}', _inflate(zlib.decompressobj(), text, budget)
        elif kind == b'IEND':
            break
    if image:
        yield 'image data', _inflate(zlib.decompressobj(), b''.join(image), budget)


def _icns(data: bytes, budget: list[int]) -> Iterator[tuple[str, bytes]]:
    total = min(struct.unpack('>I', data[4:8])[0], len(data))
    position = 8
    while position + 8 <= total:
        kind, length = struct.unpack('>4sI', data[position:position + 8])
        if length < 8 or position + length > total:
            raise Unreadable(f'the {kind!r} entry has a bad length')
        yield kind.decode('latin-1'), data[position + 8:position + length]
        position += length


OPENERS = {
    'zip archive': _zip,
    'gzip stream': _gzip,
    'bzip2 stream': _bzip2,
    'xz stream': _xz,
    'tar archive': _tar,
    'PNG image': _png,
    'icns icon': _icns,
}

"""Stable filesystem facts from a container export; no extraction or imports outside stdlib."""
import hashlib
import posixpath
import sys
import tarfile


def escaped(value):
    return ''.join('%%%02X' % ord(c) if c.isspace() or c == '%' else c for c in value)


def normalized(value):
    parts = value.lstrip('/').split('/')
    if '..' in parts:
        raise ValueError('unsafe tar path: ' + value)
    return posixpath.normpath('/' + value.lstrip('/'))


entries = {}
with tarfile.open(fileobj=sys.stdin.buffer, mode='r|*') as archive:
    for member in archive:
        name = normalized(member.name)
        if name in entries:
            raise ValueError('duplicate tar path: ' + name)
        detail = '-'
        if member.isfile():
            kind = 'file'
            digest = hashlib.sha256()
            stream = archive.extractfile(member)
            while True:
                block = stream.read(1024 * 1024)
                if not block:
                    break
                digest.update(block)
            detail = digest.hexdigest()
        elif member.isdir():
            kind = 'dir'
        elif member.issym():
            kind, detail = 'symlink', escaped(member.linkname)
        elif member.islnk():
            kind, detail = 'hardlink', escaped(normalized(member.linkname))
        elif member.ischr():
            kind, detail = 'char', '%d:%d' % (member.devmajor, member.devminor)
        elif member.isblk():
            kind, detail = 'block', '%d:%d' % (member.devmajor, member.devminor)
        elif member.isfifo():
            kind = 'fifo'
        else:
            raise ValueError('unsupported tar entry: ' + member.name)
        entries[name] = '%s %s %04o %d %d %s' % (
            escaped(name), kind, member.mode, member.uid, member.gid, detail)
for name in sorted(entries):
    print(entries[name])

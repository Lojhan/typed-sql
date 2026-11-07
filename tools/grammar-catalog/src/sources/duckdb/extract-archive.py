"""Extract locked DuckDB vendor archives without links or special files."""
import pathlib
import re
import stat
import sys
import tarfile
import zipfile

archive_path, destination, prefix = sys.argv[1:]
if zipfile.is_zipfile(archive_path):
    if prefix != "--flat":
        raise ValueError("Only flat DuckDB library zip archives are supported")
    with zipfile.ZipFile(archive_path) as archive:
        names = set()
        members = archive.infolist()
        if not members:
            raise ValueError("Empty DuckDB library archive")
        for member in members:
            path = pathlib.PurePosixPath(member.filename)
            mode = member.external_attr >> 16
            if (
                path.is_absolute()
                or len(path.parts) != 1
                or not re.fullmatch(r"[A-Za-z0-9_.-]+", member.filename)
                or member.filename != path.as_posix()
                or path.parts[0] in (".", "..")
                or member.filename in names
                or member.is_dir()
                or member.flag_bits & 1
                or stat.S_IFMT(mode) not in (0, stat.S_IFREG)
            ):
                raise ValueError("Nonregular flat DuckDB library archive member")
            names.add(member.filename)
        root = pathlib.Path(destination)
        root.mkdir(parents=True, exist_ok=True)
        for member in members:
            (root / member.filename).write_bytes(archive.read(member))
    sys.exit(0)
with tarfile.open(archive_path, "r:gz") as archive:
    members = archive.getmembers()
    names = set()
    selected = []
    if not members:
        raise ValueError("Empty DuckDB archive")
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if (
            path.is_absolute()
            or ".." in path.parts
            or member.name.rstrip("/") != path.as_posix()
            or not path.parts
            or (prefix != "--flat" and path.parts[0] != prefix)
            or (prefix == "--flat" and len(path.parts) != 1)
            or member.name in names
        ):
            raise ValueError("Noncanonical DuckDB archive member")
        names.add(member.name)
        # Source archives contain symlink fixtures. Only headers and the license are inputs.
        needed = prefix == "--flat" or path.parts[1:3] == ("src", "include") or path.parts[1:] == ("LICENSE",)
        if needed:
            if not (member.isfile() or member.isdir()):
                raise ValueError("Nonregular DuckDB extractor input")
            selected.append(member)
    if not selected:
        raise ValueError("Missing DuckDB extractor inputs")
    archive.extractall(destination, members=selected, filter="data")

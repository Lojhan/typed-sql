"""Select catalog build inputs from an immutable PostgreSQL source archive."""
import json
import pathlib
import sys
import tarfile

archive_path, destination, prefix = sys.argv[1:]
with tarfile.open(archive_path, "r:gz") as archive:
    names = set()
    selected = []
    files = []
    for member in archive.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if (path.is_absolute() or ".." in path.parts or not path.parts
                or member.name.rstrip("/") != path.as_posix()
                or path.parts[0] != prefix or member.name in names):
            raise ValueError("Noncanonical PostgreSQL archive member")
        names.add(member.name)
        local = pathlib.PurePosixPath(*path.parts[1:])
        needed = (
            local.as_posix() in ("COPYRIGHT", "configure.ac", "src/backend/catalog/Catalog.pm",
                                 "src/include/parser/kwlist.h", "src/backend/parser/gram.y",
                                 "src/backend/bootstrap/bootstrap.c")
            or (local.parent.as_posix() == "src/include/catalog" and local.suffix in (".dat", ".h"))
            or (local.parent.as_posix() == "src/backend/catalog" and local.suffix in (".sql", ".txt"))
        )
        if needed:
            if not member.isfile():
                raise ValueError("Nonregular PostgreSQL extractor input")
            selected.append(member)
            files.append(local.as_posix())
    required = {"COPYRIGHT", "configure.ac", "src/backend/catalog/Catalog.pm",
                "src/include/parser/kwlist.h", "src/backend/parser/gram.y",
                "src/include/catalog/pg_proc.dat", "src/include/catalog/pg_type.dat"}
    if not required.issubset(files):
        raise ValueError("Missing PostgreSQL catalog inputs")
    archive.extractall(destination, members=selected, filter="data")
    print(json.dumps(sorted(files)))

"""Extract exactly requested regular ScriptDOM source members from the pinned archive."""
import json
import pathlib
import sys
import tarfile

archive_path, destination, prefix, requested = sys.argv[1:]
paths = set(json.loads(requested))
if not paths or any(not isinstance(path, str) for path in paths):
    raise ValueError("Missing ScriptDOM source selection")
with tarfile.open(archive_path, "r:gz") as archive:
    names = set()
    found = set()
    selected = []
    for member in archive.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if (
            path.is_absolute()
            or ".." in path.parts
            or "\\" in member.name
            or ":" in member.name
            or member.name.rstrip("/") != path.as_posix()
            or not path.parts
            or path.parts[0] != prefix
            or member.name in names
        ):
            raise ValueError("Noncanonical ScriptDOM archive member")
        names.add(member.name)
        relative = "/".join(path.parts[1:])
        if relative in paths:
            if not member.isfile():
                raise ValueError("Nonregular ScriptDOM source input")
            selected.append(member)
            found.add(relative)
    if found != paths:
        raise ValueError("Missing ScriptDOM archive inputs")
    archive.extractall(destination, members=selected, filter="data")
print(json.dumps(sorted(found)))

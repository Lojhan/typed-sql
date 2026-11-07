"""Extract a vendor archive into a fresh directory without links or special files."""
import pathlib
import sys
import tarfile

archive_path, destination, revision = sys.argv[1:]
root = pathlib.Path(destination)
expected = f"sqlite-{revision}"
with tarfile.open(archive_path, "r:gz") as archive:
    members = archive.getmembers()
    if not members:
        raise ValueError("Empty SQLite source archive")
    names = set()
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if (
            path.is_absolute()
            or ".." in path.parts
            or member.name.rstrip("/") != path.as_posix()
            or not path.parts
            or path.parts[0] != expected
            or member.name in names
            or not (member.isfile() or member.isdir())
        ):
            raise ValueError("Noncanonical SQLite source archive member")
        names.add(member.name)
    archive.extractall(root, members=members, filter="data")

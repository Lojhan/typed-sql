"""Extract locked DuckDB vendor archives without links or special files."""
import pathlib
import sys
import tarfile

archive_path, destination, prefix = sys.argv[1:]
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

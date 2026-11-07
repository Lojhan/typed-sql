"""Extract registration/keyword inputs from the pinned MySQL source archive."""
import json
import pathlib
import sys
import tarfile

archive_path, destination, prefix = sys.argv[1:]
required = {"LICENSE", "MYSQL_VERSION", "sql/item_create.cc", "sql/item_create.h",
            "sql/lex.h", "sql/lex_symbol.h", "sql/sql_yacc.yy", "sql/gen_keyword_list.cc"}
with tarfile.open(archive_path, "r:gz") as archive:
    seen = set()
    selected = []
    found = set()
    for member in archive.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if (path.is_absolute() or ".." in path.parts or not path.parts
                or member.name.rstrip("/") != path.as_posix()
                or path.parts[0] != prefix or member.name in seen):
            raise ValueError("Noncanonical MySQL source archive member")
        seen.add(member.name)
        local = pathlib.PurePosixPath(*path.parts[1:]).as_posix()
        if local in required:
            if not member.isfile():
                raise ValueError("Nonregular MySQL source input")
            selected.append(member)
            found.add(local)
    if found != required:
        raise ValueError("Missing MySQL source inputs: " + repr(required - found))
    archive.extractall(destination, members=selected, filter="data")
    print(json.dumps(sorted(found)))

from pathlib import Path


def uncomment_line(line: str) -> str:
    if line.startswith("# ////"):
        return line[7:]
    if line.startswith("#  "):
        return line[3:]
    if line.startswith("# "):
        return line[2:]
    return line


def main() -> None:
    path = Path(__file__).resolve().parent.parent / "CM.py"
    lines = [uncomment_line(l) for l in path.read_text(encoding="utf-8").splitlines(keepends=True)]
    text = "".join(lines)
    if not text.startswith("#!"):
        if text.startswith("////"):
            text = "#!" + text[4:]
        elif text.lstrip().startswith("!/usr/bin"):
            text = "#" + text.lstrip()
    path.write_text(text, encoding="utf-8")
    print("CM.py uncommented")


if __name__ == "__main__":
    main()

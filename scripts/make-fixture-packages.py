#!/usr/bin/env python3
"""scripts/spikes/s02/ext-* を `.unnoplugin`（zip）にして、crates/extensions/tests/fixtures/packages/ へ書く。

009 のテスト用の拡張機能（base・rect・bad）。マニフェストがパッケージの直下に来る。
再現できるよう、時刻と順序を固定する。使い方: python3 scripts/make-fixture-packages.py
"""
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "scripts/spikes/s02"
OUT = ROOT / "crates/extensions/tests/fixtures/packages"
FIXED_TIME = (2026, 1, 1, 0, 0, 0)


def build(ext_dir: Path, out_file: Path) -> None:
    files = sorted(p for p in ext_dir.rglob("*") if p.is_file())
    with zipfile.ZipFile(out_file, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in files:
            info = zipfile.ZipInfo(path.relative_to(ext_dir).as_posix(), FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, path.read_bytes())


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for ext_dir in sorted(SRC.glob("ext-*")):
        out_file = OUT / f"{ext_dir.name}.unnoplugin"
        build(ext_dir, out_file)
        print(f"書き出した: {out_file.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

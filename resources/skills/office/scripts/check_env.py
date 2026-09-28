"""检查修改办公文件需要的本机依赖，输出 JSON。只检测，不安装任何东西。"""
import importlib.util
import json
import shutil
import sys

LIBRARIES = {
    "python-docx": "docx",
    "openpyxl": "openpyxl",
    "python-pptx": "pptx",
    "pypdf": "pypdf",
}


def main() -> None:
    result = {
        "python": sys.version.split()[0],
        "libraries": {name: importlib.util.find_spec(module) is not None for name, module in LIBRARIES.items()},
        "libreoffice": shutil.which("soffice") or shutil.which("libreoffice"),
    }
    missing = [name for name, ok in result["libraries"].items() if not ok]
    result["missing"] = missing
    result["install_hint"] = f"pip install {' '.join(missing)}" if missing else None
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

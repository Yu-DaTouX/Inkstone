---
name: office
description: 读取、修改或生成 Word（.docx）、Excel（.xlsx）、PowerPoint（.pptx）和 PDF 文件时使用。说明如何读文件、用本机 Python 库修改、核对结果，以及缺少依赖时怎么如实告诉用户。
---

# 办公文件

砚负责把**磁盘上的真实文件**展示给用户（文件预览只显示文字；审查面板显示与最近一次提交的逐行对比）。这个技能负责告诉你怎么读、怎么改。不要用「已修改」的文字代替真实修改，改完必须重新读一遍核对。

## 1. 读

- 先用 `yan office read --path <文件>` 读文字内容：Word 按段落，Excel 按工作表与单元格（含公式），PPT 按页（含备注），PDF 按正文。结果文件里有 `sections`。
- 只有文字，没有版式、图片和样式。需要样式信息时，再用下面的 Python 库读。

## 2. 检查环境（第一次修改前）

运行本技能目录下的 `scripts/check_env.py`（与本文件同目录的 `scripts/` 里）：

```bash
python scripts/check_env.py
```

它输出 JSON，列出 `python-docx`、`openpyxl`、`python-pptx`、`pypdf`、LibreOffice 是否可用。

- 缺少需要的库时：**不要自行安装**。告诉用户缺什么和安装命令（例如 `pip install python-docx openpyxl python-pptx`），也可以用 `yan capabilities need` 说明缺口，等用户决定。
- 没有 Python 时同样如实说明，不要改用手工拼 XML 之类的做法冒险改文件。

## 3. 改之前

- 确认要改的文件和范围（哪一页、哪一段、哪些单元格）。范围不清就先问。
- 文件不在 Git 仓库里时，先复制一份备份（例如 `报告.backup.docx`），并告诉用户备份位置；在 Git 仓库里时，审查面板能对比最近一次提交，不必另存。
- 文件正被 Word / Excel 打开时保存会失败，请用户先关闭。

## 4. 修改方法

写一段短 Python 脚本完成修改，只改需要改的部分：

- **Word（python-docx）**：按段落定位；替换文字时尽量改已有 run 的 `text`，保留样式；新段落用 `insert_paragraph_before` 或在目标段落后插入。表格按 `doc.tables[i].cell(r, c)` 定位。
- **Excel（openpyxl）**：`load_workbook(path)` 修改单元格值或公式（公式以 `=` 开头的字符串写入）。openpyxl **不会计算公式**：写入后读到的是公式本身。需要计算结果时，有 LibreOffice 就用 `soffice --headless --convert-to xlsx` 重算一份再读，没有就告诉用户打开文件后会重新计算。不要用 `data_only=True` 读取后再保存（会丢掉公式）。
- **PowerPoint（python-pptx）**：按页 `prs.slides[i]`、按形状的 `text_frame` 修改文字；备注在 `slide.notes_slide`。新增页用已有版式 `prs.slide_layouts[k]`。
- **PDF**：只读与提取（`yan office read` 或 pypdf）。不要尝试修改已有 PDF 的版式；需要新 PDF 时，先生成 docx，再用 LibreOffice 转换（`soffice --headless --convert-to pdf`）。
- **新建文件**：用对应库从空白文档开始；保存到用户指定的位置，没有指定就放在当前项目里并说明路径。

## 5. 改完之后

1. 再用 `yan office read --path <文件>` 读一遍，确认改动确实写进去了。
2. 向用户说明改了哪里：第几页 / 哪一段 / 哪些单元格，原来是什么、现在是什么。
3. 提示用户可以在文件预览或审查面板里查看真实内容与前后对比；版式与图片请用 Office 打开确认。

## 边界

- 复杂排版、原生修订与批注、宏、数据透视表、扫描件 OCR 不保证支持，遇到时如实说明。
- 不要删除或覆盖用户没让你动的文件；覆盖原文件前必须已有备份或 Git 版本。

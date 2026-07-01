# DOCX Chinese Markdown Translation Design

## Goal

Translate `5_6206486969766144370.docx` into Chinese Markdown and save it as `5_6206486969766144370.zh.md` in the repository root.

## Source

- Input file: `5_6206486969766144370.docx`
- Source content: a short English explanation comparing `Sanctioned Entities` and `Debarred Entities`, including numbered sections, a summary comparison table, an overlap note, and a closing question.

## Output Format

- Use Markdown.
- Preserve the source structure as readable Chinese:
  - title
  - introductory paragraphs
  - numbered sections
  - comparison table
  - overlap note
  - closing question
- Convert the source comparison table into a Markdown table.

## Translation Rules

- Translate the full meaning into Chinese.
- Preserve key English compliance and legal terms for bilingual reference by writing them as `中文（English）`.
- Use this treatment for recurring domain terms such as:
  - `受制裁实体（Sanctioned Entities）`
  - `除名/禁止参与实体（Debarred Entities）`
  - `制裁（Sanctions）`
  - `除名/禁止参与（Debarment）`
  - `资产冻结（asset freezes）`
  - `金融交易禁令（bans on financial transactions）`
  - `公共采购（public procurement）`
  - `监管合规（regulatory compliance）`

## Verification

- Confirm the Markdown file exists at `5_6206486969766144370.zh.md`.
- Confirm the table renders as a Markdown table.
- Confirm the translated text keeps English keywords where they support Chinese-English comparison.
- Confirm no unrelated repository files are modified or staged.

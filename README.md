# Examens Nationaux SVT — 2BAC SVT (BIOF), Maroc — Dataset AI-ready

Complete, clean, AI-readable dataset of the Moroccan Baccalaureate national
exams (**Examen National Unifié du Baccalauréat**) in **Sciences de la Vie et
de la Terre**, track **2BAC SVT (French BIOF option)**, sessions **2016–2025**,
each with **Normal (الدورة العادية)** + **Rattrapage (الدورة الاستدراكية)**
sessions and an official-style **correction** for every exam.

Built for **ASTER**, an AI teacher: search, retrieve, display, explain, solve.

## Layout

```
dataset/svt/examens-nationaux/
├── manifest.json                  # machine-readable index (coverage, sources, topics)
├── 2016/{normal,rattrapage}/
│   ├── exam.txt                   # transcription (front-matter + body + notes)
│   ├── correction.txt             # idem, corrigé
│   ├── exam.pdf                   # generated text edition (searchable)
│   └── correction.pdf
├── … 2017 … 2025 …
└── 2026/{normal,rattrapage}/      # pending (see below)
tools/
├── discover.py                    # scrape AlloSchool section/5191 → element/PDF URLs
├── build_manifest.py              # regenerate manifest.json
├── txt2pdf.py                     # build the PDFs from the txt files
└── fonts/                         # vendored OFL fonts (DejaVu Sans, Noto Naskh Arabic)
```

## Coverage (20/22 sessions)

| Year | Normale | Rattrapage | Réf. |
|------|---------|------------|------|
| 2016–2025 | ✅ sujet + corrigé | ✅ sujet + corrigé | NS32F/NR32F · RS32F/RR32F |
| 2026 | ⏳ pending | ⏳ pending | — |

Part II exercise topics per session are tagged in `manifest.json`
(e.g. 2025N: sarcopénie/apéline, Walker-Warburg/DAG1, crêtes poulets,
Listeria ; 2024R: myopathie RyR1, Miyoshi/DYSF, linkage souris, THC…).

## Sources & provenance

- Sujets & corrigés transcribed from the official papers (**CNE**,
  « عناصر الإجابة ») via **AlloSchool** (`section/5191`, course-398 PDFs).
- Every file carries YAML front-matter with `Source:` (direct PDF URL) and
  `Element:` (AlloSchool element page). AlloSchool element IDs used:
  2020N 109869/109871 · 2020R 109872/109873 · 2021N 127309/138538 ·
  2021R 138539/138540 · 2022N 138541/138542 · 2022R 138543/138544 ·
  2023N 142315/142316 · 2023R 142317/142318 · 2024N 145877/145878 ·
  2024R 145879/145880 · 2025N 145636/145881 · 2025R 145882/145883
  (2016–2019 IDs in front-matter).
- Scope: **2BAC SVT only** (coef 7), **French BIOF only**.

## Transcription conventions

- UTF-8 `.txt`, YAML front-matter (`Matière, Filière, Chapitre, Sujet, Type,
  Source, Element`), body in light Markdown (`##`, `###`, tables).
- Arabic header blocks preserved; figures described as
  `[Figure — …]` (never silently dropped).
- Uncertain readings are flagged inline (`[sic]`, `[reconstitué …]`) and every
  file ends with a `FIN` marker + `NOTES DE TRANSCRIPTION` footer explaining
  each reconstruction (missing figures, illegible values, corrigé/sujet
  discrepancies).
- PDFs are **generated text editions** (searchable, full metadata), not scans:
  rebuild with `python3 tools/txt2pdf.py [year]`
  (requires `fpdf2`, `arabic_reshaper`, `python-bidi`).

## 2026 status

As of 2026-09-19 the 2026 SVT-track papers are **not machine-obtainable**:
`section/5191` still ends at 2025R, AlloSchool site search returns nothing for
2026, predictable `…-2026-normale-*.pdf` URLs return *File Not Found*,
talamidi/moutamadris/baclibre top out at ≤2025, 9rayti's section is empty,
kezakoo is login-walled, CNEE (cnee.men.gov.ma) is unreachable, and the
Wayback Machine has no snapshot. The June-2026 Normale paper does circulate
(svtsciences.com advertises it with « عناصر الاجابة », but the page is
JS-rendered with non-extractable links; a YouTube video shows the scanned
booklet, but for the PC track, not SVT). When the SVT PDFs become available:
drop transcriptions into `2026/{normal,rattrapage}/`, rebuild PDFs +
manifest, done.

## Validation

- 40/40 txt files: front-matter complete, single `FIN` marker, notes footer.
- Part II point totals = 15 for all 20 sessions (asserted by manifest build).
- 40/40 PDFs build and carry extractable text + metadata.

#!/usr/bin/env python3
"""Build dataset/svt/examens-nationaux/manifest.json from the txt/PDF files.

Usage:
    python3 tools/build_manifest.py

The manifest is the machine-readable index of the dataset for the AI
teacher (ASTER): coverage, provenance URLs, reference codes, page counts
and per-exercise topic tags for retrieval.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / "dataset" / "svt" / "examens-nationaux"

# (points, topic tags, short label) per exercise — curated from the papers.
TOPICS = {
    "2016": {
        "normal": [
            (3, ["muscle", "contraction", "Ca2+"], "Contraction musculaire, rôle de Ca2+"),
            (4, ["génétique humaine", "rétinite pigmentaire", "rhodopsine", "expression"], "Rétinite pigmentaire / rhodopsine"),
            (5, ["drosophile", "transmission", "diversité génétique"], "Drosophile : transmission et diversité"),
            (3, ["immunité", "grippe", "virus"], "Réponse immunitaire contre la grippe"),
        ],
        "rattrapage": [
            (5, ["hémochromatose", "hepcidine", "fer", "protéine"], "Hémochromatose / hépcidine"),
            (4, ["moustiques", "transmission", "population"], "Moustiques : transmission, structure de population"),
            (3, ["immunité", "bactéries", "toxines"], "Immunité anti-bactérienne (toxines)"),
            (3, ["géologie", "Alpes", "collision"], "Chaîne alpine : collision"),
        ],
    },
    "2017": {
        "normal": [
            (3, ["métabolisme", "ATP", "lactate", "aérobie", "anaérobie"], "Voies métaboliques de l'ATP, lactate"),
            (6, ["génétique humaine", "mucoviscidose"], "Mucoviscidose"),
            (3, ["moustiques", "transmission", "couleur yeux", "couleur corps"], "Moustiques : yeux et corps"),
            (3, ["géologie", "subduction", "magma", "andésite"], "Subduction : origine du magma"),
        ],
        "rattrapage": [
            (4, ["expression génétique", "gène-caractère"], "Gènes, caractères, expression"),
            (5, ["pois", "transmission", "Hardy-Weinberg"], "Pois : transmission, structure génique"),
            (3, ["immunité acquise"], "Immunité acquise"),
            (3, ["géologie", "plaques", "chaînes de montagnes"], "Plaques et chaînes de montagnes"),
        ],
    },
    "2018": {
        "normal": [
            (6, ["génétique humaine", "polykystose rénale"], "Polykystose rénale"),
            (3, ["drosophile", "transmission"], "Drosophile : croisements"),
            (3, ["immunité", "vaccination"], "Vaccination : mécanismes immunitaires"),
            (3, ["géologie", "métamorphisme", "chaîne de montagnes"], "Métamorphisme et chaîne de montagnes"),
        ],
        "rattrapage": [
            (3, ["respiration", "mitochondrie", "antimycine A"], "Respiration, antimycine A"),
            (5, ["transmission", "expression génétique"], "Transmission et expression de l'information génétique"),
            (4, ["escargot", "Cepaea", "transmission", "population"], "Escargot Cepaea : diploïdes, variation"),
            (3, ["immunité", "LT4"], "Lymphocytes T4"),
        ],
    },
    "2019": {
        "normal": [
            (3.25, ["muscle", "sprint", "ATP", "métabolisme"], "Sprint : ATP et métabolisme"),
            (4.75, ["génétique humaine", "neurofibromatose"], "Neurofibromatose de type 1"),
            (3.25, ["phlox", "transmission", "couleur", "forme"], "Phlox : couleurs et formes"),
            (3.75, ["immunité", "VIH", "SIDA"], "VIH / SIDA"),
        ],
        "rattrapage": [
            (4.5, ["BPOC", "alpha-antitrypsine", "protéine"], "BPOC / α-antitrypsine"),
            (4, ["poissons", "transmission", "yeux", "nageoire"], "Poissons : yeux, nageoire caudale"),
            (3.5, ["immunité", "grippe", "virus"], "Réponse immunitaire contre la grippe"),
            (3, ["géologie", "chaînes de montagnes"], "Formation des chaînes de montagnes"),
        ],
    },
    "2020": {
        "normal": [
            (5, ["muscle", "contraction", "énergie"], "Muscle : énergie chimique → mécanique"),
            (6.5, ["génétique humaine", "Rendu-Osler-Weber"], "Maladie de Rendu-Osler-Weber"),
            (3.5, ["ovins", "transmission", "oreilles", "museau"], "Ovins : oreilles, museau"),
        ],
        "rattrapage": [
            (5, ["métabolisme", "glycogénose", "GSD-0", "effort"], "Glycogénose type 0, effort musculaire"),
            (6.5, ["génétique humaine", "Kennedy", "lié au sexe"], "Maladie de Kennedy"),
            (3.5, ["tomate", "transmission"], "Tomate : croisements"),
        ],
    },
    "2021": {
        "normal": [
            (5.5, ["métabolisme", "cyanure", "HCN", "respiration"], "Acide cyanhydrique, asphyxie"),
            (6.5, ["génétique humaine", "Tay-Sachs"], "Maladie de Tay-Sachs"),
            (3, ["chien", "cocker", "transmission", "pelage"], "Cocker : couleur et aspect du pelage"),
        ],
        "rattrapage": [
            (5, ["McArdle", "métabolisme", "muscle", "lactate"], "Maladie de McArdle"),
            (6.5, ["génétique humaine", "PYGM", "glycogénose V", "Hardy-Weinberg"], "Glycogénose type V / PYGM"),
            (3.5, ["maïs", "liaison", "20 cM"], "Maïs : gènes liés (20 cM)"),
        ],
    },
    "2022": {
        "normal": [
            (4.5, ["génétique humaine", "Blackfan"], "Maladie de Blackfan"),
            (4.5, ["drosophile", "liaison", "19 cM", "sélection naturelle"], "Drosophile vg/b liés, sélection"),
            (3, ["immunité", "humorale", "cellulaire", "hémagglutinine"], "Immunités humorale et cellulaire"),
            (3, ["géologie", "subduction", "fosse", "prisme"], "Subduction : fosse, prisme, volcanisme"),
        ],
        "rattrapage": [
            (3, ["myopathie", "glycogène", "myophosphorylase", "fermentation"], "Myopathie : glycogène, lactate"),
            (4.5, ["génétique humaine", "MCR1", "albinisme"], "MCR1 / albinisme"),
            (4.5, ["souris", "transmission", "indépendance", "sélection naturelle"], "Souris : indépendance, sélection"),
            (3, ["immunité", "DiGeorge", "thymus", "coopération"], "DiGeorge : coopération LB+LT"),
        ],
    },
    "2023": {
        "normal": [
            (3, ["NARP", "ATP-synthase", "mitochondrie", "O2"], "NARP : chaîne respiratoire, O2"),
            (5, ["génétique humaine", "Fabry", "alpha-GAL", "lié X", "Hardy-Weinberg"], "Fabry / α-GAL, lié X"),
            (4, ["maïs", "liaison", "10 cM"], "Maïs R/A liés (10 cM)"),
            (3, ["géologie", "Zagros", "collision", "métamorphisme"], "Zagros : collision, HP-BT"),
        ],
        "rattrapage": [
            (3, ["muscle", "fibres", "aérobie", "anaérobie"], "Fibres musculaires, effort"),
            (5.75, ["génétique humaine", "Bruton", "lié X", "Hardy-Weinberg"], "Bruton, lié X"),
            (3.25, ["lapins", "codominance", "létal"], "Lapins : codominance G/B, létal L"),
            (3, ["immunité", "coopération", "Nossal", "interleukines"], "Coopération immunitaire (Nossal)"),
        ],
    },
    "2024": {
        "normal": [
            (3, ["2-DG", "cancer", "glycolyse", "hexokinase", "ATP"], "2-désoxy-glucose et cancer"),
            (5, ["génétique humaine", "Charcot", "SOD1", "dominant"], "Charcot / SOD1, dominant"),
            (3, ["bovins", "Dexter", "létal", "cornes"], "Bovins Dexter : létal D, cornes"),
            (4, ["immunité", "ASLO", "streptocoques", "coopération"], "ASLO / streptocoques"),
        ],
        "rattrapage": [
            (3, ["myopathie", "RyR1", "Ca2+", "contraction"], "Myopathie RyR1 / Ca2+"),
            (5, ["génétique humaine", "Miyoshi", "dysferline", "DYSF"], "Miyoshi / dysferline (DYSF)"),
            (3, ["souris", "linkage absolu", "linkage relatif", "test-cross"], "Souris : linkage absolu → relatif"),
            (4, ["immunité", "THC", "tumeur", "IFN-gamma", "cellulaire"], "THC et immunité anti-tumorale"),
        ],
    },
    "2025": {
        "normal": [
            (3, ["sarcopénie", "apéline", "mitochondrie", "myosine"], "Sarcopénie / apéline"),
            (6, ["génétique humaine", "Walker-Warburg", "DAG1", "dystroglycane", "Hardy-Weinberg"], "Walker-Warburg / DAG1"),
            (3, ["poulets", "crête", "létal"], "Poulets : crête R/r, couleur A/a létal"),
            (3, ["immunité", "Listeria", "cellulaire", "macrophages"], "Listeria : immunité cellulaire"),
        ],
        "rattrapage": [
            (3, ["muscle", "Huxley", "glissement", "actomyosine", "ATP"], "Huxley : théorie du glissement"),
            (6, ["génétique humaine", "Pompe", "alpha-GA", "Hardy-Weinberg"], "Pompe / α-GA"),
            (3, ["tomate", "linkage relatif", "crossing-over", "test-cross"], "Tomate : linkage relatif"),
            (3, ["géologie", "subduction", "Indo-Myanmar", "ophiolite", "collision"], "Indo-Myanmar : subduction, collision"),
        ],
    },
}


def front_matter(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    meta = {}
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            for line in text[3:end].strip().splitlines():
                if ":" in line:
                    key, val = line.split(":", 1)
                    meta[key.strip()] = val.strip()
    return meta


def pdf_pages(path: Path) -> int | None:
    try:
        import pymupdf  # PyMuPDF, optional
    except ImportError:
        try:
            import fitz as pymupdf
        except ImportError:
            return None
    try:
        with pymupdf.open(path) as doc:
            return doc.page_count
    except Exception:
        return None


def main() -> None:
    sessions = []
    for year in sorted(p.name for p in BASE.iterdir() if p.is_dir()):
        for session in ("normal", "rattrapage"):
            d = BASE / year / session
            exam_txt = d / "exam.txt"
            corr_txt = d / "correction.txt"
            if not exam_txt.exists():
                sessions.append({"year": year, "session": session, "status": "missing"})
                continue
            exam_meta = front_matter(exam_txt)
            corr_meta = front_matter(corr_txt) if corr_txt.exists() else {}
            fr = "الدورة العادية" if session == "normal" else "الدورة الاستدراكية"
            exercises = [
                {"n": i + 1, "points": pts, "label": label, "tags": tags}
                for i, (pts, tags, label) in enumerate(TOPICS[year][session])
            ]
            sessions.append({
                "year": year,
                "session": session,
                "session_ar": fr,
                "status": "complete",
                "reference_exam": "NS32F" if session == "normal" else "RS32F",
                "reference_corrige": "NR32F" if session == "normal" else "RR32F",
                "files": {
                    "exam_txt": f"{year}/{session}/exam.txt",
                    "correction_txt": f"{year}/{session}/correction.txt",
                    "exam_pdf": f"{year}/{session}/exam.pdf",
                    "correction_pdf": f"{year}/{session}/correction.pdf",
                },
                "sources": {
                    "exam": exam_meta.get("Source", ""),
                    "exam_element": exam_meta.get("Element", ""),
                    "correction": corr_meta.get("Source", ""),
                    "correction_element": corr_meta.get("Element", ""),
                },
                "pages": {
                    "exam_pdf": pdf_pages(d / "exam.pdf"),
                    "correction_pdf": pdf_pages(d / "correction.pdf"),
                },
                "coef": 7,
                "duree": "3h",
                "partie1_points": 5,
                "partie2_points": 15,
                "exercises": exercises,
            })
    manifest = {
        "dataset": "Examens Nationaux SVT — 2BAC SVT (BIOF), Maroc",
        "matiere": "Sciences de la Vie et de la Terre",
        "filiere": "Sciences de la Vie et de la Terre (2BAC SVT — BIOF)",
        "langue": "fr",
        "sessions": sessions,
        "notes": ("Corrigés = transcriptions des éléments de réponse officiels "
                  "(CNE) via AlloSchool. 2026 : non publié par AlloSchool au "
                  "2026-09-19 (voir README)."),
    }
    out = BASE / "manifest.json"
    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    n_ok = sum(1 for s in sessions if s["status"] == "complete")
    print(f"Wrote {out} ({n_ok}/{len(sessions)} complete).")


if __name__ == "__main__":
    main()

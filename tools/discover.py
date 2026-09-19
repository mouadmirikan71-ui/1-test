"""Discover all SVT (2BAC SVT BIOF) national exam elements on AlloSchool.

Scrapes the 'Examens Nationaux' section (section-5191) of the SVT course,
then each element page to extract the direct PDF download URL.

Output: tools/manifest_raw.json
"""
import json
import re
import time
import urllib.request

BASE = "https://www.alloschool.com"
SECTION_URL = f"{BASE}/section/5191"
COURSE_URL = (f"{BASE}/course/sciences-de-la-vie-et-de-la-terre-"
              "svt-2eme-bac-sciences-de-la-vie-et-de-la-terre-biof")

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"),
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
}


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
    # site is utf-8
    return raw.decode("utf-8", errors="replace")


def main() -> None:
    print(f"Fetching section page: {SECTION_URL}", flush=True)
    try:
        html = fetch(SECTION_URL)
        print(f"  section HTML length: {len(html)}")
    except Exception as exc:  # noqa: BLE001
        print(f"  section page failed: {exc}")
        html = ""

    if len(html) < 5000:
        print(f"Falling back to course page: {COURSE_URL}", flush=True)
        html = fetch(COURSE_URL)
        print(f"  course HTML length: {len(html)}")

    # Find all element links with their titles.
    # AlloSchool lists elements as <a href=".../element/12345">Title</a>
    pattern = re.compile(
        r'href="(https://www\.alloschool\.com/element/(\d+))"[^>]*>(.*?)</a>',
        re.DOTALL,
    )
    found = {}
    for url, eid, inner in pattern.findall(html):
        title = re.sub(r"<[^>]+>", "", inner).strip()
        title = re.sub(r"\s+", " ", title)
        if "Examen National SVT" in title and "BAC SVT" in title:
            found[eid] = {"element_id": eid, "title": title, "url": url}

    print(f"Found {len(found)} candidate exam elements")
    for eid in sorted(found, key=int):
        print(f"  {eid}: {found[eid]['title']}") 

    # Parse year/session/kind from title
    title_re = re.compile(
        r"Examen National SVT 2[eè]me BAC SVT (\d{4}) (Normale|Rattrapage) - (Sujet|Corrigé)",
        re.IGNORECASE,
    )
    items = []
    for eid, info in sorted(found.items(), key=lambda kv: int(kv[0])):
        m = title_re.search(info["title"])
        if not m:
            print(f"  SKIP (unparsed title): {info['title']}")
            continue
        year, session, kind = m.group(1), m.group(2).lower(), m.group(3).lower()
        session = "normal" if session == "normale" else "rattrapage"
        kind = "sujet" if kind == "sujet" else "corrige"
        items.append({
            "year": int(year),
            "session": session,
            "kind": kind,
            **info,
            "pdf_url": None,
        })

    # Fetch each element page to extract the direct PDF URL
    pdf_re = re.compile(
        r'href="(https://www\.alloschool\.com/assets/documents/[^"]+\.pdf)"'
    )
    for i, item in enumerate(items):
        try:
            page = fetch(item["url"])
            m = pdf_re.search(page)
            if m:
                item["pdf_url"] = m.group(1)
                print(f"[{i+1}/{len(items)}] {item['year']} {item['session']} "
                      f"{item['kind']} -> {item['pdf_url'].split('/')[-1]}")
            else:
                print(f"[{i+1}/{len(items)}] {item['year']} {item['session']} "
                      f"{item['kind']} -> NO PDF LINK FOUND!")
        except Exception as exc:  # noqa: BLE001
            print(f"[{i+1}/{len(items)}] {item['year']} {item['session']} "
                  f"{item['kind']} -> ERROR: {exc}")
        time.sleep(0.4)

    with open("tools/manifest_raw.json", "w", encoding="utf-8") as fh:
        json.dump(items, fh, ensure_ascii=False, indent=2)
    print(f"\nWrote tools/manifest_raw.json with {len(items)} items, "
          f"{sum(1 for it in items if it['pdf_url'])} with PDF URLs.")


if __name__ == "__main__":
    main()

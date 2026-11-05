# 🎓 Master Study Hub

A local AI study companion for master's students in Software Engineering.
Upload your course **PPTX** slides and **PDF** files and get a master-level **study guide** for each one, in **English or Arabic**:

- **Overview**: what the material covers and how the ideas connect
- **Section-by-section explanations** with slide/page references
- **Key concepts**: definition, a real-world example, and where each one appears
- **Key takeaways**, **prerequisites**, and **"Go deeper"** directions (advanced topics, seminal papers, open questions)
- **Course glossary**: every key concept across all documents of a course, searchable
- **Source view**: the extracted text of every slide/page, including speaker notes. Click any reference chip to jump there.

Everything runs on your PC. Only the document text is sent to Google Gemini when a study guide is generated.

## Quick start (Windows)

1. Install [Node.js](https://nodejs.org) 20 or newer.
2. Double-click **`start.bat`**. The first run installs dependencies, then the app opens at http://localhost:3210.
3. Go to **Settings**, paste a free Gemini API key from https://aistudio.google.com/apikey, and click **Test connection**.
4. Create a course, drop your PPTX/PDF files, and wait for the study guides to finish.

Or from a terminal:

```bash
npm install
npm start        # opens the browser
npm test         # extraction tests
```

## Configuration

| Setting | Where | Default |
|---|---|---|
| Gemini API key | Settings page, or `GEMINI_API_KEY` env var | – |
| Model | Settings page, or `GEMINI_MODEL` env var | `gemini-flash-latest` |
| Port | `PORT` env var | `3210` |
| Data folder | `STUDY_DATA_DIR` env var | `./data` |

Click **Detect best model** in Settings to choose from the models your key can actually use. If Google retires the
configured model, the app switches to the newest available Flash model automatically and saves it.
Pick a "pro" model for deeper explanations (slower, with tighter free-tier limits).

## Notes

- Old `.ppt` files: open them in PowerPoint and *Save As* `.pptx`.
- Scanned PDFs (images without text, up to 18 MB) are sent to Gemini as a file so it can read them with OCR.
- Your data (originals, extracted text, study guides, API key) lives in `data/`. Back up this folder to keep your library.

## Project structure

```
server.js           Express server + REST API
lib/extract.js      PPTX/PDF text extraction (per slide/page, with speaker notes)
lib/summarize.js    Study-guide prompt + JSON schema for Gemini
lib/gemini.js       Minimal Gemini REST client with retries
lib/queue.js        Sequential background generation queue
lib/store.js        JSON/file storage in data/
public/             Frontend (vanilla JS, English/Arabic with RTL)
test/               Extraction tests
```

## Roadmap ideas

Chat with course materials (with citations) · flashcards and spaced repetition · quiz/exam generator ·
research paper writing assistant (IEEE/ACM structure, BibTeX) · literature search (arXiv / Semantic Scholar) ·
research project tracker · study planner.

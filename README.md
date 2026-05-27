# JankBot

JankBot is a local HTML web app for Magic: The Gathering card and Commander deck recommendations. It uses Scryfall as the source of truth, a deterministic synergy and budget scorer for recommendations, and Ollama for chat parsing/explanations.

## Requirements

- Node.js 20+
- Ollama: https://ollama.com

Install and start Ollama:

```powershell
winget install Ollama.Ollama
ollama pull qwen2.5:0.5b
ollama serve
```

Run the app:

```powershell
npm start
```

Open:

```text
http://localhost:3000
```

The default model is `qwen2.5:0.5b`, chosen because the app does the heavy deterministic card scoring itself and needs a fast local model for strict JSON parsing and concise explanations on modest local hardware. Override it with `OLLAMA_MODEL` if you want a larger model:

```powershell
$env:OLLAMA_MODEL="llama3.1"
npm start
```

On first use, JankBot downloads Scryfall Oracle Cards bulk data and stores a compact local cache in `data/`. This is intentional: Scryfall asks large-data applications to use bulk downloads rather than repeated live API searches.

## Example Prompts

```text
Give me a deck based around Teysa Karlov.
Give me a card that works well with Yarok, the Desecrated.
Give me a deck based around Niv-Mizzet, Parun.
```

## Production-Grade Guardrails

- Scryfall is the only source of card truth.
- Ollama never invents cards; model output is constrained to validated app data.
- Recommendations are scored before the LLM explains them.
- Commander color identity, singleton rules, legality, deck size, curve, roles, and prices are checked.
- API calls are rate-limited and cache-first.
- The app does not silently use fallback chat responses or fake card data.

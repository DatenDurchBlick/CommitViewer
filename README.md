# CommitViewer

Eine Progressive Web App (PWA) zur Anzeige von Git-Commit-Graphen von GitHub-Repositories — direkt im iPhone-Browser, ohne das Repo zu klonen.

## Features

- **Git Graph Visualisierung** — ähnlich `git log --graph --all --oneline`
- **Mehrere Repositories** — schnell zwischen Repos wechseln, Favoriten markieren
- **Offline-Fähigkeit** — letzte Daten werden gecacht
- **Touch-optimiert** — flüssiges Scrollen auf iPhone
- **Dark Mode** — automatisch basierend auf System-Präferenz
- **Als App installierbar** — "Zum Home-Bildschirm hinzufügen"

## Setup

### 1. GitHub Personal Access Token erstellen

Gehe zu: [GitHub Settings → Tokens](https://github.com/settings/tokens/new?description=CommitViewer&scopes=repo,public_repo)

Benötigte Scopes:
- `public_repo` — für öffentliche Repositories
- `repo` — für private Repositories

### 2. App öffnen

Die App läuft auf GitHub Pages:  
`https://<username>.github.io/CommitViewer/`

### 3. Einrichtung

1. Token eingeben
2. Repository im Format `owner/repository` eingeben
3. "Speichern & Graph laden" tippen
4. Optional: "Zum Home-Bildschirm hinzufügen"

## Datenschutz & Sicherheit

- Token wird **nur lokal** im `localStorage` gespeichert
- **Keine Daten** werden an externe Server gesendet
- Alle API-Calls gehen direkt zu `api.github.com` (HTTPS)
- Token ist **nie** im Code hardcoded

## GitHub Pages aktivieren

1. Repository-Settings öffnen
2. Pages → Source: "Deploy from a branch"
3. Branch: `main`, Folder: `/ (root)`
4. Speichern

## Datei-Struktur

```
/
├── index.html          # Haupt-App
├── manifest.json       # PWA Manifest
├── service-worker.js   # Offline-Funktionalität
├── css/style.css       # Styling
├── js/
│   ├── app.js          # Hauptlogik
│   ├── github-api.js   # GitHub API Wrapper
│   └── graph.js        # Canvas-basierter Git-Graph
└── icons/              # PWA Icons
```

## API Rate Limits

GitHub API erlaubt 5.000 Requests/Stunde mit Token. Die App zeigt verbleibende Anfragen in der Status-Bar, wenn das Limit unter 100 fällt.

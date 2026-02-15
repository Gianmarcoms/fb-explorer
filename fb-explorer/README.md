# Flow-Based Market Coupling Explorer

Interactive visualization of how the EU Day-Ahead electricity market uses the Flow-Based method to allocate cross-border transmission capacity.

## Features

- **FB Domain** — 2D polytope of feasible zone net positions, adjustable RAM sliders
- **PTDF Matrix** — heatmap of Power Transfer Distribution Factors
- **RAM Breakdown** — stacked bars showing Fmax → RAM decomposition
- **Flow Calculator** — live dot-product calculation with expandable step-by-step breakdowns

## Local development

```bash
npm install
npm run dev
```

## Deploy to GitHub Pages

1. Create a GitHub repo named `fb-explorer` (or change `base` in `vite.config.js` to match your repo name)
2. Push this project to the `main` branch
3. In repo Settings → Pages, set source to **GitHub Actions**
4. The included workflow (`.github/workflows/deploy.yml`) will build and deploy automatically on every push

Your site will be live at `https://Gianmarcoms.github.io/fb-explorer/`

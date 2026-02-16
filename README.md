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

website live at `https://gianmarcoms.github.io/fb-explorer/`

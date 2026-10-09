/// <reference types="vite/client" />

declare module 'plotly.js-dist-min' {
  // Plotly's own typings lag the 3.x API; the app wraps it in a single component.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Plotly: any
  export default Plotly
}

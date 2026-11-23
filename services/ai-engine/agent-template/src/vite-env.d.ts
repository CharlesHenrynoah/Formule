/// <reference types="vite/client" />
declare global { interface Window { mcp?: { call: (tool: string, args?: unknown) => Promise<any>; tools: () => Promise<any[]> } } }
export {};

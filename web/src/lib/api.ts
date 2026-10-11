/** API origin is same-origin locally and configurable for production deployments. */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL?.trim() || '/api/v1').replace(/\/+$/, '');

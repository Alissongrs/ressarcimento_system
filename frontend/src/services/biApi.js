import axios from 'axios';

const origin = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : '';
const biBase = origin ? `${origin}/bi/` : '/bi/';
const biApi = axios.create({ baseURL: biBase });

biApi.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('userToken');
    if (token) {
      config.headers = { ...(config.headers || {}), Authorization: `Bearer ${token}` };
    }
    // Keep relative URLs (no leading slash) so baseURL '/bi/' is preserved
    return config;
  },
  (error) => Promise.reject(error)
);

export default biApi;

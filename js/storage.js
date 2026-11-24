const WORKSPACE_KEY = 'traceable-stv:workspace:v1';
const REPORTS_KEY = 'traceable-stv:reports:v1';

export function loadWorkspace() {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    console.warn('workspace load failed', error);
    return null;
  }
}

export function saveWorkspace(state) {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    console.warn('workspace save failed', error);
    return false;
  }
}

export function loadReports() {
  try {
    const raw = localStorage.getItem(REPORTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((report) => report && typeof report === 'object' && !Array.isArray(report))
      : [];
  } catch (error) {
    console.warn('reports load failed', error);
    return [];
  }
}

export function saveReports(reports) {
  try {
    localStorage.setItem(REPORTS_KEY, JSON.stringify(reports));
    return true;
  } catch (error) {
    console.warn('reports save failed', error);
    return false;
  }
}

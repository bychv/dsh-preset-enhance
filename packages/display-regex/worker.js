import { transformDisplayText } from './regex/display-regex.mjs';
self.onmessage = ({ data }) => {
  try { self.postMessage({ id: data.id, result: transformDisplayText(data.task) }); }
  catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};

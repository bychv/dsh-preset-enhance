import { transformDisplayText } from './regex/display-regex.mjs';
const scope = self;
scope.onmessage = ({ data }) => {
    try {
        scope.postMessage({ id: data.id, result: transformDisplayText(data.task) });
    }
    catch (error) {
        scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : '正则执行失败' });
    }
};

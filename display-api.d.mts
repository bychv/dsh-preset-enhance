/** Public optional display capability, scoped to the host plugin lifetime. */
export declare const PRESET_DISPLAY_SERVICE = "presetDisplayRegex";
export declare const PRESET_DISPLAY_EVENT = "preset-display/availability";
export interface PresetDisplayCapability {
    readonly apiVersion: 1;
    readonly instance: string;
    readonly ready: boolean;
}
export interface DisplayAvailability {
    apiVersion: 1;
    available: boolean;
    instance: string | null;
}

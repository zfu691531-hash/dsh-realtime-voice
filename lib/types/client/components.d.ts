import type { VoiceController } from './controller.ts';
export declare function MicButton({ controller }: {
    controller: VoiceController;
}): import("react").JSX.Element;
interface NativeInputProps {
    input: {
        readonly draft: string;
        readonly draftRev: number;
        readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting';
    };
    inputActions: {
        setDraft(text: string): void;
        submit(): void;
    };
}
export declare function VoiceStatus({ controller, input, inputActions }: {
    controller: VoiceController;
} & NativeInputProps): import("react").JSX.Element | null;
export declare function SettingsCard(): import("react").JSX.Element;
export {};

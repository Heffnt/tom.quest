"use client";

import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/app/lib/auth";
import { usePersistedSettings } from "@/app/lib/hooks/use-persisted-settings";
import { debug, registerState, unregisterState } from "@/app/lib/debug";
import type { Id } from "@/convex/_generated/dataModel";
import MenuBubble from "./components/menu-bubble";
import ChatSidebar from "./components/chat-sidebar";
import Preview from "./components/preview";
import ProviderModelPicker from "./components/provider-model-picker";
import { resolveLlm, type Provider } from "./lib/models";

const log = debug.scoped("canvas");

type ActiveCanvasSetting = { id: string };
type LlmSetting = { provider: Provider; model: string };

export default function CanvasClient() {
  const { user, isTom, loading: authLoading } = useAuth();

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-text-faint text-sm">Loading…</span>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="border border-border rounded-lg bg-surface px-5 py-4 text-sm text-text-muted max-w-sm">
          Sign in to author canvases. Each user gets their own library.
        </div>
      </div>
    );
  }

  return <CanvasEditor isTom={isTom} />;
}

function CanvasEditor({ isTom }: { isTom: boolean }) {
  const canvases = useQuery(api.canvas.listMine, {});
  const create = useMutation(api.canvas.create);

  const [activeSetting, setActiveSetting] = usePersistedSettings<ActiveCanvasSetting>(
    "canvas:active",
    { id: "" },
  );
  const [llmSetting, setLlmSetting] = usePersistedSettings<LlmSetting>(
    "canvas:llm",
    { provider: "openai-oauth", model: "gpt-5.5" },
  );

  const resolved = useMemo(
    () => resolveLlm(llmSetting, isTom),
    [llmSetting, isTom],
  );

  // If saved provider/model resolved to something different (role gate or stale),
  // sync the persisted setting so the picker shows the current truth.
  useEffect(() => {
    if (
      resolved.provider !== llmSetting.provider ||
      resolved.model !== llmSetting.model
    ) {
      setLlmSetting(resolved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved.provider, resolved.model]);

  // Auto-create on first arrival when the user has no canvases.
  const autoCreating = useRef(false);
  useEffect(() => {
    if (canvases === undefined) return;
    if (canvases.length === 0 && !autoCreating.current) {
      autoCreating.current = true;
      void create({}).then(({ canvasId }) => {
        setActiveSetting({ id: canvasId });
        autoCreating.current = false;
      });
    }
  }, [canvases, create, setActiveSetting]);

  // Resolve the active canvas: persisted choice if it still exists, else most recent.
  const activeCanvasId = useMemo<Id<"canvases"> | null>(() => {
    if (!canvases || canvases.length === 0) return null;
    const persisted = canvases.find((c) => c._id === activeSetting.id);
    return (persisted?._id ?? canvases[0]._id) as Id<"canvases">;
  }, [canvases, activeSetting.id]);

  // If the persisted choice is stale, update it once we know the resolved id.
  useEffect(() => {
    if (activeCanvasId && activeCanvasId !== activeSetting.id) {
      setActiveSetting({ id: activeCanvasId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCanvasId]);

  const canvas = useQuery(
    api.canvas.get,
    activeCanvasId ? { id: activeCanvasId } : "skip",
  );

  // Diagnostic state.
  useEffect(() => {
    registerState("canvas", () => ({
      activeCanvasId: activeCanvasId ?? null,
      activeChatId: canvas?.activeChatId ?? null,
      canvasCount: canvases?.length ?? 0,
      provider: resolved.provider,
      model: resolved.model,
    }));
    return () => unregisterState("canvas");
  }, [activeCanvasId, canvas?.activeChatId, canvases?.length, resolved.provider, resolved.model]);

  if (canvases === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-text-faint text-sm">Loading canvases…</span>
      </div>
    );
  }

  if (!activeCanvasId || !canvas) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-text-faint text-sm">Preparing canvas…</span>
      </div>
    );
  }

  const onSelectCanvas = (id: Id<"canvases">) => {
    setActiveSetting({ id });
    log.log("switch canvas", { id });
  };

  return (
    <div className="h-[calc(100vh-4rem)] flex">
      <div className="flex-1 relative flex flex-col min-w-0">
        <div className="absolute top-3 left-3 z-20">
          <MenuBubble
            canvases={canvases}
            activeCanvasId={activeCanvasId}
            onSelect={onSelectCanvas}
          />
        </div>
        <div className="absolute top-3 right-3 z-20">
          <ProviderModelPicker
            isTom={isTom}
            provider={resolved.provider}
            model={resolved.model}
            onChange={(next) => setLlmSetting(next)}
          />
        </div>
        <Preview html={canvas.html} canvasName={canvas.name} canvasId={activeCanvasId} />
      </div>
      <ChatSidebar canvasId={activeCanvasId} canvas={canvas} />
    </div>
  );
}

"use client";

import { useEffect, useRef, useCallback } from "react";
import { usePathname } from "next/navigation";
import UAParser from "ua-parser-js";
import { createBrowserSupabaseClient } from "../lib/supabase";

function generateDeviceId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getDeviceName(): string {
  const parser = new UAParser();
  const result = parser.getResult();
  const browser = result.browser.name || "Unknown Browser";
  const os = result.os.name || "Unknown OS";
  return `${browser} on ${os}`;
}

export default function DeviceTracker() {
  const pathname = usePathname();
  const supabaseRef = useRef(createBrowserSupabaseClient());
  const pageEnterTimeRef = useRef<number>(Date.now());
  const currentPathRef = useRef<string>(pathname);
  const visitIdRef = useRef<string | null>(null);
  const deviceIdRef = useRef<string | null>(null);

  const getOrCreateDeviceId = useCallback(() => {
    if (deviceIdRef.current) return deviceIdRef.current;
    let deviceId = localStorage.getItem("device_id");
    if (!deviceId) {
      deviceId = generateDeviceId();
      localStorage.setItem("device_id", deviceId);
    }
    deviceIdRef.current = deviceId;
    return deviceId;
  }, []);

  const registerDevice = useCallback(async () => {
    const supabase = supabaseRef.current;
    const deviceId = getOrCreateDeviceId();
    const deviceName = getDeviceName();
    const { data: existing } = await supabase
      .from("devices")
      .select("id, total_visits")
      .eq("device_id", deviceId)
      .single();
    if (existing) {
      await supabase
        .from("devices")
        .update({
          last_seen: new Date().toISOString(),
          total_visits: existing.total_visits + 1,
        })
        .eq("device_id", deviceId);
    } else {
      await supabase.from("devices").insert({
        device_id: deviceId,
        device_name: deviceName,
      });
    }
  }, [getOrCreateDeviceId]);

  const logPageVisit = useCallback(async (path: string) => {
    const supabase = supabaseRef.current;
    const deviceId = getOrCreateDeviceId();
    const { data } = await supabase
      .from("page_visits")
      .insert({
        device_id: deviceId,
        path,
      })
      .select("id")
      .single();
    if (data) {
      visitIdRef.current = data.id;
    }
  }, [getOrCreateDeviceId]);

  const updateVisitDuration = useCallback(async () => {
    if (!visitIdRef.current) return;
    const supabase = supabaseRef.current;
    const duration = Math.round((Date.now() - pageEnterTimeRef.current) / 1000);
    await supabase
      .from("page_visits")
      .update({ duration_seconds: duration })
      .eq("id", visitIdRef.current);
    // Also update total time on device
    const deviceId = getOrCreateDeviceId();
    const { data: device } = await supabase
      .from("devices")
      .select("total_time_seconds")
      .eq("device_id", deviceId)
      .single();
    if (device) {
      await supabase
        .from("devices")
        .update({
          total_time_seconds: device.total_time_seconds + duration,
          last_seen: new Date().toISOString(),
        })
        .eq("device_id", deviceId);
    }
  }, [getOrCreateDeviceId]);

  // Register device on mount
  useEffect(() => {
    registerDevice();
  }, [registerDevice]);

  // Log page visit on pathname change
  useEffect(() => {
    // Update duration of previous page visit
    if (currentPathRef.current !== pathname && visitIdRef.current) {
      updateVisitDuration();
    }
    // Log new page visit
    currentPathRef.current = pathname;
    pageEnterTimeRef.current = Date.now();
    logPageVisit(pathname);
  }, [pathname, logPageVisit, updateVisitDuration]);

  // Update duration on page unload
  useEffect(() => {
    const handleBeforeUnload = () => {
      updateVisitDuration();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [updateVisitDuration]);

  return null;
}

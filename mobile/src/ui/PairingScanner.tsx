import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { CameraView } from "expo-camera";
import { Button } from "./primitives";
import { useTheme } from "./theme";

type Scan = { data: string };

export function PairingScanner({ enabled, onScan }: { enabled: boolean; onScan(event: Scan): void }) {
  const { palette } = useTheme();
  const [fallback, setFallback] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [ready, setReady] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const guided = Platform.OS === "ios" && CameraView.isModernBarcodeScannerAvailable && !fallback;
  const enabledRef = useRef(enabled);
  const onScanRef = useRef(onScan);
  const alive = useRef(false);
  const presented = useRef(false);
  const opening = useRef(false);
  const accepted = useRef(false);

  useEffect(() => { enabledRef.current = enabled; onScanRef.current = onScan; }, [enabled, onScan]);
  useEffect(() => {
    alive.current = true;
    if (!guided) return () => { alive.current = false; };
    const subscription = CameraView.onModernBarcodeScanned((event) => {
      if (!alive.current || !presented.current || !enabledRef.current || accepted.current || !event.data.trim()) return;
      // Native detection may deliver the same QR more than once before a render.
      accepted.current = true;
      void CameraView.dismissScanner().then(() => {
        presented.current = false;
        if (alive.current && enabledRef.current) onScanRef.current(event);
      }).catch(() => {
        if (alive.current) setCameraError(true);
      });
    });
    return () => {
      alive.current = false;
      subscription.remove();
      if (presented.current) {
        presented.current = false;
        void CameraView.dismissScanner().catch(() => undefined);
      }
    };
  }, [guided]);

  const open = async () => {
    if (opening.current || !enabledRef.current) return;
    opening.current = true;
    accepted.current = false;
    presented.current = true;
    setLaunching(true);
    setCameraError(false);
    try {
      await CameraView.launchScanner({
        barcodeTypes: ["qr"], isGuidanceEnabled: true,
        isHighlightingEnabled: true, isPinchToZoomEnabled: true,
      });
    } catch {
      presented.current = false;
      if (alive.current) setFallback(true);
    } finally {
      opening.current = false;
      if (alive.current) setLaunching(false);
    }
  };

  if (guided) {
    return (
      <View style={styles.guide}>
        <Text style={[styles.title, { color: palette.ink }]}>Scan your Mac’s QR code</Text>
        <Text style={[styles.detail, { color: palette.muted }]}>Keep the entire code in view. The scanner highlights a detected code; pinch to zoom if needed.</Text>
        <Button label={launching ? "Opening camera…" : "Open QR scanner"} disabled={!enabled || launching} onPress={() => void open()} />
        {cameraError ? <Text style={[styles.detail, { color: palette.danger }]}>Close the camera and try again, or choose Type code.</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.camera}>
      {/* Expo maps "off" to continuous autofocus on iOS. CameraView does not
          support children, so the aiming guide must be a sibling. */}
      <CameraView facing="back" autofocus="off" style={StyleSheet.absoluteFill}
        onCameraReady={() => setReady(true)} onMountError={() => setCameraError(true)}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={enabled ? onScan : undefined} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.overlay]}>
        <Text style={styles.cameraHint}>Center the entire QR code</Text>
        <View style={styles.frame} />
        <Text style={styles.cameraHint}>{cameraError ? "Camera could not start. Close and retry, or choose Type code." : !enabled ? "Scanning paused" : ready ? "Looking for a QR code… Move back until it is sharp." : "Starting camera…"}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  guide: { flex: 1, justifyContent: "center", gap: 18, paddingHorizontal: 24 },
  title: { fontSize: 21, fontWeight: "600", textAlign: "center" },
  detail: { fontSize: 15, lineHeight: 22, textAlign: "center" },
  camera: { flex: 1, borderRadius: 18, overflow: "hidden", backgroundColor: "black" },
  overlay: { alignItems: "center", justifyContent: "center", gap: 20, paddingHorizontal: 16 },
  frame: { width: 230, height: 230, borderRadius: 16, borderWidth: 3, borderColor: "white" },
  cameraHint: { color: "white", backgroundColor: "#00000099", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, textAlign: "center", fontSize: 14 },
});

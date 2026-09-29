/**
 * SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
 * SPDX-License-Identifier: MIT
 */
export async function mediaSource(kind: "audio" | "video") {
  if (kind === "audio") {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return { stream, close: async () => {
      stream.getTracks().forEach(track => track.stop());
    } };
  }
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext("2d")!;
  let frame = 0;
  const paint = () => {
    context.fillStyle = `hsl(${frame++ * 10 % 360}, 100%, 50%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
  };
  paint();
  const stream = canvas.captureStream(15);
  const timer = setInterval(paint, 60);
  return { stream, close: async () => {
    clearInterval(timer);
    stream.getTracks().forEach(track => track.stop());
  } };
}

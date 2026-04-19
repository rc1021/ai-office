/**
 * voice-listener.ts — Discord Voice Channel → local Whisper STT
 *
 * Flow:
 *   User joins voice channel → bot joins → listens per-user
 *   → EndBehaviorType.AfterSilence(1500ms) auto-closes stream
 *   → PCM buffer → write temp .wav → whisper-node (local whisper.cpp)
 *   → transcribed text → onTranscript callback → runClaude pipeline
 *
 * STT: whisper-node (Node.js bindings for whisper.cpp), model: medium, language: from office.yaml
 */

import {
  joinVoiceChannel,
  EndBehaviorType,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  type VoiceReceiver,
} from "@discordjs/voice";
import * as prism from "prism-media";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { VoiceState, VoiceChannel, Guild } from "discord.js";

import { whisper } from "whisper-node";

// ── Types ──

export type VoiceTranscriptCallback = (
  userId: string,
  displayName: string,
  text: string
) => Promise<void>;

type WhisperSegment = { start: string; end: string; speech: string };

// ── State ──

let onTranscript: VoiceTranscriptCallback | null = null;
const activeUsers = new Set<string>(); // prevent overlapping transcription for same user
let whisperLanguage = "zh"; // default; updated from office.yaml via setWhisperLanguage()

export function setVoiceTranscriptCallback(cb: VoiceTranscriptCallback): void {
  onTranscript = cb;
}

export function setWhisperLanguage(lang: string): void {
  whisperLanguage = lang;
}

// ── voiceStateUpdate handler (called from listener.ts) ──

export function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState
): void {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return; // ignore bots

  const guild = newState.guild ?? oldState.guild;

  // User joined a voice channel → bot joins if not already there
  if (newState.channelId && newState.channel?.isVoiceBased()) {
    const existing = getVoiceConnection(guild.id);
    if (!existing) {
      void joinAndListen(newState.channel as VoiceChannel, guild);
    }
  }

  // User left → if channel is now empty of humans, bot leaves
  if (oldState.channelId && oldState.channel?.isVoiceBased()) {
    const channel = oldState.channel as VoiceChannel;
    const humans = channel.members.filter((m) => !m.user.bot).size;
    if (humans === 0) {
      const conn = getVoiceConnection(guild.id);
      if (conn) {
        conn.destroy();
        console.log("[VoiceListener] Channel empty — bot left");
      }
    }
  }
}

// ── Join and set up per-user listeners ──

async function joinAndListen(
  channel: VoiceChannel,
  guild: Guild
): Promise<void> {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,  // must hear audio
    selfMute: true,   // bot doesn't speak
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    console.log(`[VoiceListener] Joined: ${channel.name}`);
  } catch (err) {
    connection.destroy();
    console.error("[VoiceListener] Failed to join voice channel:", err);
    return;
  }

  connection.on("error", (err) =>
    console.error("[VoiceListener] Connection error:", err)
  );

  const receiver = connection.receiver;

  receiver.speaking.on("start", (userId: string) => {
    const member = guild.members.cache.get(userId);
    if (!member || member.user.bot) return;
    const displayName = member.displayName ?? member.user.username;

    void recordAndTranscribe(receiver, userId, displayName);
  });
}

// ── Record one utterance and transcribe ──

async function recordAndTranscribe(
  receiver: VoiceReceiver,
  userId: string,
  displayName: string
): Promise<void> {
  if (activeUsers.has(userId)) return;
  activeUsers.add(userId);

  const audioStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
  });

  // Opus → 16kHz mono PCM
  const decoder = new prism.opus.Decoder({
    rate: 16000,
    channels: 1,
    frameSize: 960,
  });

  const chunks: Buffer[] = [];
  audioStream.pipe(decoder);
  decoder.on("data", (chunk: Buffer) => chunks.push(chunk));

  await new Promise<void>((resolve) => decoder.once("end", resolve));
  activeUsers.delete(userId);

  if (chunks.length === 0) return;

  const tmpWav = path.join(os.tmpdir(), `voice-${userId}-${Date.now()}.wav`);
  try {
    writePcmToWav(chunks, tmpWav);

    console.log(`[VoiceListener] Transcribing for ${displayName}...`);
    const result: WhisperSegment[] | undefined = await whisper(tmpWav, {
      modelName: "medium",
      whisperOptions: { language: whisperLanguage },
    });

    const text = (result ?? []).map((s) => s.speech).join(" ").trim();
    if (text && onTranscript) {
      console.log(`[VoiceListener] "${displayName}" said: ${text}`);
      await onTranscript(userId, displayName, text);
    }
  } catch (err) {
    console.error("[VoiceListener] Transcription error:", err);
  } finally {
    try { fs.unlinkSync(tmpWav); } catch { /* best effort */ }
  }
}

// ── Write PCM buffer as 16kHz mono 16-bit WAV ──

function writePcmToWav(pcmChunks: Buffer[], outPath: string): void {
  const pcm = Buffer.concat(pcmChunks);
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);           // PCM chunk size
  header.writeUInt16LE(1, 20);            // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(outPath, Buffer.concat([header, pcm]));
}

// Leon's 15-second sponsor introduction: four spoken lines, the same wording as the site's captions
// (keys leon.l1..leon.l4 in assets/site.js). Optional voice: Google Cloud Text-to-Speech, one MP3 per line,
// stored in the public bucket leon-voice as <sponsor id>/1.mp3 .. 4.mp3.
import { db } from './db.ts';

type Lang = 'ko' | 'en' | 'zh';
type Sponsor = { id: string; sponsor_type: string; display_name: string; message: string | null; lang: Lang };

const who = (s: Sponsor) => s.lang === 'ko' && s.sponsor_type === 'person' ? `${s.display_name} 님` : s.display_name;
const LINES: Record<Lang, (s: Sponsor) => string[]> = {
  ko: (s) => [
    '안녕하세요, 저는 레온이에요!',
    `오늘 이 이야기에 가치참여를 하신 분은 바로 ${who(s)}!`,
    '가치참여에 함께 했습니다.',
    `고마워요, ${who(s)}! 이제 영웅의 이야기를 들려드릴게요.`,
  ],
  en: (s) => [
    "Hi, I'm Leon!",
    `Today's value participant in this story is ${who(s)}!`,
    'They joined in value participation.',
    `Thank you, ${who(s)}! Now, here's our hero's story.`,
  ],
  zh: (s) => [
    '大家好，我是萊昂！',
    `今天為這個故事價值參與的是──${who(s)}！`,
    '一起加入了價值參與。',
    `謝謝${who(s)}！現在，讓我們一起聆聽英雄的故事。`,
  ],
};

const VOICE: Record<Lang, { languageCode: string; name: string }> = {
  ko: { languageCode: 'ko-KR', name: Deno.env.get('LEON_VOICE_KO') ?? 'ko-KR-Neural2-C' },
  en: { languageCode: 'en-US', name: Deno.env.get('LEON_VOICE_EN') ?? 'en-US-Neural2-I' },
  zh: { languageCode: 'cmn-TW', name: Deno.env.get('LEON_VOICE_ZH') ?? 'cmn-TW-Wavenet-B' },
};

export function leonLines(s: Sponsor): string[] {
  return (LINES[s.lang] ?? LINES.ko)(s);
}

// Returns the storage prefix when the voice was made, or null when TTS is not configured or fails.
export async function makeLeonVoice(s: Sponsor): Promise<string | null> {
  const key = Deno.env.get('GOOGLE_TTS_API_KEY');
  if (!key) return null;
  const voice = VOICE[s.lang] ?? VOICE.ko;
  const lines = leonLines(s);
  try {
    for (let i = 0; i < lines.length; i++) {
      const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text: lines[i] },
          voice,
          audioConfig: { audioEncoding: 'MP3', speakingRate: 1.05, pitch: 2.0 },
        }),
      });
      if (!r.ok) throw new Error('tts ' + r.status + ' ' + (await r.text()).slice(0, 200));
      const { audioContent } = await r.json();
      const bytes = Uint8Array.from(atob(audioContent), (c) => c.charCodeAt(0));
      const { error } = await db.storage.from('leon-voice').upload(`${s.id}/${i + 1}.mp3`, bytes, {
        contentType: 'audio/mpeg', upsert: true,
      });
      if (error) throw error;
    }
    await db.from('sponsors').update({ voice_path: s.id }).eq('id', s.id);
    return s.id;
  } catch (e) {
    console.error('leon voice failed', e);
    return null;
  }
}

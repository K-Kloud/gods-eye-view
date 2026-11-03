// Shared, bounded account data. Provider keys and local investigation data never belong here.
export const EMPTY_PROFILE = Object.freeze({
  name: '',
  organization: '',
  role: '',
  bio: '',
  country: '',
  language: 'en',
  timeZone: 'Africa/Lagos',
  voiceTier: 'standard',
  views: [],
});

export function normalizeProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('invalid_profile');
  const text = (key, max) => {
    const value = input[key] ?? EMPTY_PROFILE[key];
    if (
      typeof value !== 'string' ||
      value.length > max ||
      (key === 'bio' ? /[\u0000-\u0009\u000b-\u001f]/ : /[\u0000-\u001f]/).test(
        value,
      )
    )
      throw new Error('invalid_profile');
    return value.trim();
  };
  const result = {
    name: text('name', 80),
    organization: text('organization', 120),
    role: text('role', 80),
    bio: text('bio', 500),
    country: text('country', 80),
    language: text('language', 10),
    timeZone: text('timeZone', 80),
    voiceTier: text('voiceTier', 20),
  };
  if (
    !['en', 'es', 'ru', 'zh-CN'].includes(result.language) ||
    !['standard', 'mini'].includes(result.voiceTier)
  )
    throw new Error('invalid_profile');
  try {
    new Intl.DateTimeFormat('en', { timeZone: result.timeZone });
  } catch {
    throw new Error('invalid_profile');
  }
  const views = input.views ?? [];
  if (!Array.isArray(views) || views.length > 20)
    throw new Error('invalid_profile');
  result.views = views.map((view) => {
    if (
      !view ||
      typeof view.name !== 'string' ||
      !view.name.trim() ||
      view.name.length > 80 ||
      typeof view.hash !== 'string' ||
      view.hash.length > 8000 ||
      /[\r\n]/.test(view.hash) ||
      !/^#v=2&[A-Za-z0-9_%.,=&+\-]*$/.test(view.hash)
    )
      throw new Error('invalid_profile');
    return { name: view.name.trim(), hash: view.hash };
  });
  return result;
}

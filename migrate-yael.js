const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function migrate() {
  // 1. Créer le compte Supabase Auth
  const { data, error } = await supabase.auth.admin.createUser({
    email: 'yaelboon26@gmail.com',
    password: 'Talion2026!',
    email_confirm: true,
  });
  if (error) { console.error('Auth error:', error.message); return; }
  const newId = data.user.id;
  console.log('✅ Supabase Auth créé:', newId);

  // 2. Migrer le profil admin_users
  const { error: e2 } = await supabase.from('admin_users')
    .update({ id: newId })
    .eq('id', 'usr-de0bcec0');
  if (e2) console.error('admin_users update error:', e2.message);
  else console.log('✅ admin_users migré');

  // 3. Mettre à jour les relationships qui référencent usr-de0bcec0
  const { data: users } = await supabase.from('admin_users').select('id, relationships');
  for (const u of users || []) {
    const rels = u.relationships || [];
    const updated = rels.map(r => r.userId === 'usr-de0bcec0' ? { ...r, userId: newId } : r);
    if (JSON.stringify(rels) !== JSON.stringify(updated)) {
      await supabase.from('admin_users').update({ relationships: updated }).eq('id', u.id);
      console.log('✅ Relationships mis à jour pour', u.id);
    }
  }

  console.log('\n✅ Migration terminée. Nouveau ID Yaël:', newId);
  console.log('Mot de passe temporaire: Talion2026!');
}

migrate().catch(console.error);

'use strict';
// Данные для отчёта «Команда» (раздел «Финансы», только учредитель): всё по работе агентов одним запросом.
const { def, P } = require('./api');
const PREFS = require('./prefs');

def('teamData', 'owner', (db, u) => {
  const crm = require('./crm').crmLoad(db, u);
  const since = Date.now() - 90 * 86400e3;
  return {
    users: PREFS.all(db).map(x => ({ id: x.id, name: x.name, role: x.role, active: x.active, photo: x.prefs.photo || 0, finAgentId: x.prefs.finAgentId || '', novofonEmpId: x.prefs.novofonEmpId || '' })),
    objects: crm.objects, leads: crm.leads, tasks: crm.tasks, deals: crm.deals, objContact: crm.objContact, lastContact: crm.lastContact, files: crm.files,
    calls: db.prepare('SELECT data, status FROM calls WHERE at>?').all(since).map(r => { const c = P(r.data) || {}; return { id: c.id, at: c.at, dir: c.dir, lost: c.lost, userId: c.userId || null, status: r.status }; }),
    inquiries: db.prepare('SELECT data FROM inquiries').all().map(r => P(r.data)).filter(Boolean)
      .map(q => ({ id: q.id, objectId: q.objectId, at: q.at, who: q.who, stage: q.stage, leadId: q.leadId, svc: q.svc, userId: q.userId, showTaskId: q.showTaskId }))
  };
});

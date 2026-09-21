-- Ao reatribuir o responsável de um lead captado, o trigger cancel_orphaned_tasks
-- marca as tarefas antigas como completed=true (status='cancelled'). Isso disparava
-- os triggers de "tarefa concluída" (first contact + mover etapa), que escrevem de
-- volta no MESMO lead durante o UPDATE em andamento -> erro 27000
-- ("tuple to be updated was already modified by an operation triggered by the current
-- command"). Além do crash, cancelar uma tarefa não deve contar como concluí-la
-- (marcava 1º contato e movia o funil por engano).
-- Fix: os triggers de conclusão de tarefa passam a ignorar tarefas canceladas.

DROP TRIGGER IF EXISTS trg_capture_first_contact_task ON public.company_activities;
CREATE TRIGGER trg_capture_first_contact_task
  AFTER UPDATE ON public.company_activities
  FOR EACH ROW
  WHEN (new.completed = true
        AND old.completed IS DISTINCT FROM true
        AND new.lead_id IS NOT NULL
        AND coalesce(new.status, '') <> 'cancelled')
  EXECUTE FUNCTION trg_capture_first_contact_task();

DROP TRIGGER IF EXISTS trg_capture_task_stage_upd ON public.company_activities;
CREATE TRIGGER trg_capture_task_stage_upd
  AFTER UPDATE ON public.company_activities
  FOR EACH ROW
  WHEN (new.completed = true
        AND old.completed IS DISTINCT FROM true
        AND coalesce(new.status, '') <> 'cancelled')
  EXECUTE FUNCTION trg_capture_task_stage();

import { useParams, useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import EmailTemplateEditorWrapper from '@/components/email-marketing/EmailTemplateEditorWrapper';

export default function EmailTemplateEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  return (
    <AppLayout>
      <EmailTemplateEditorWrapper
        templateId={id === 'novo' ? undefined : id}
        onBack={() => navigate('/marketing/templates')}
      />
    </AppLayout>
  );
}

import { TriangleAlert } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';

type Props = { tool: string; args: unknown; onAnswer: (ok: boolean) => void; origin?: string };

export function ConfirmDialog({ tool, args, onAnswer, origin = 'la mini-app' }: Props) {
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onAnswer(false); }}>
      <AlertDialogContent data-testid="confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-amber-400"><TriangleAlert className="size-4" /> Action en écriture demandée par {origin}</AlertDialogTitle>
          <AlertDialogDescription>Appel de l'outil MCP suivant. Rien n'est exécuté sans votre accord.</AlertDialogDescription>
        </AlertDialogHeader>
        <Badge variant="outline" className="font-mono text-zinc-300">{tool}</Badge>
        <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-2 text-xs text-muted-foreground">{JSON.stringify(args, null, 2)}</pre>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onAnswer(false)}>Refuser</AlertDialogCancel>
          <AlertDialogAction className="bg-white text-black hover:bg-zinc-200" onClick={() => onAnswer(true)}>Autoriser</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

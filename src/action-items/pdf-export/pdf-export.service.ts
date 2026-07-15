import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';

interface ActionForExport {
  title: string;
  status: string;
  dueDate: Date | null;
}

const STATUS_LABELS: Record<string, string> = {
  todo: 'À faire',
  in_progress: 'En cours',
  done: 'Terminé',
  blocked: 'Bloqué',
  ignored: 'Ignoré',
};

@Injectable()
export class PdfExportService {
  generateActionPlanPdf(
    organizationName: string,
    actions: ActionForExport[],
  ): PDFKit.PDFDocument {
    const doc = new PDFDocument({ margin: 50 });

    doc.fontSize(18).text(`Plan d'action — ${organizationName}`, {
      underline: false,
    });
    doc
      .fontSize(10)
      .fillColor('gray')
      .text(`Généré le ${new Date().toLocaleDateString('fr-FR')}`);
    doc.moveDown(1.5);
    doc.fillColor('black');

    if (actions.length === 0) {
      doc.fontSize(12).text('Aucune action pour le moment.');
      doc.end();
      return doc;
    }

    actions.forEach((action, index) => {
      const statusLabel = STATUS_LABELS[action.status] ?? action.status;
      const dueDateLabel = action.dueDate
        ? new Date(action.dueDate).toLocaleDateString('fr-FR')
        : 'Non définie';

      doc
        .fontSize(12)
        .fillColor('black')
        .text(`${index + 1}. ${action.title}`, { continued: false });
      doc
        .fontSize(10)
        .fillColor('gray')
        .text(`Statut : ${statusLabel}    Échéance : ${dueDateLabel}`);
      doc.moveDown(0.8);
    });

    doc.end();
    return doc;
  }
}
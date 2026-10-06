import { examLabel, Language, ToolErrorCode } from "@clinicvoice/shared";
import { z } from "zod";
import { defineTool } from "./defineTool.js";
import { requireConfirmed, requireVerified } from "./guards.js";
import { agentActor, resolveAppointment } from "./shared.js";
import { fail, ok } from "./types.js";

const Input = z.object({
  appointment_ref: z.string(),
  language: Language.describe("Language of the text message"),
});

/** Sends only approved, versioned template text. The model never writes the SMS body. */
export const sendPrepInstructions = defineTool({
  name: "send_prep_instructions",
  description:
    "Text the approved preparation instructions for an appointment to the patient's phone on file. Only after propose_action and a confirmed yes.",
  input: Input,
  guards: [requireVerified, requireConfirmed("send_prep_instructions")],
  async describe(input, ctx) {
    const resolved = await resolveAppointment(ctx, input.appointment_ref);
    if (!resolved.ok) throw new Error("describe called with an unknown appointment ref");
    const exam = examLabel(resolved.appointment.examCode, ctx.session.language);
    const language =
      input.language === "fr"
        ? ctx.session.language === "fr"
          ? "en français"
          : "in French"
        : ctx.session.language === "fr"
          ? "en anglais"
          : "in English";
    return ctx.session.language === "fr"
      ? `Je vous envoie par texto les instructions de préparation pour votre ${exam}, ${language}, au numéro inscrit à votre dossier. D'accord?`
      : `I'll text the preparation instructions for your ${exam}, ${language}, to the phone number on your file. Okay?`;
  },
  async run(input, ctx) {
    const patientId = ctx.session.verifiedPatientId as string;
    const resolved = await resolveAppointment(ctx, input.appointment_ref);
    if (!resolved.ok) return resolved.result;
    const template = await ctx.messaging.findApprovedTemplate(
      resolved.appointment.examCode,
      input.language,
    );
    if (!template)
      return fail(
        ToolErrorCode.NO_TEMPLATE,
        "No approved instructions exist for this exam. Offer a staff callback instead.",
      );
    const phone = await ctx.messaging.getPatientPhone(patientId);
    if (!phone)
      return fail(
        ToolErrorCode.NO_TEMPLATE,
        "No mobile number on file. Offer a staff callback instead.",
      );

    const sent = await ctx.sms.send(phone, template.body);
    const message = await ctx.messaging.recordMessage({
      patientId,
      templateId: template.id,
      providerSid: sent.providerSid,
      status: sent.status,
    });
    await ctx.audit.write({
      actor: agentActor(ctx),
      action: "send",
      entity: "message",
      entityId: message.id,
      requestId: ctx.requestId,
    });
    return ok({ sent: true });
  },
});

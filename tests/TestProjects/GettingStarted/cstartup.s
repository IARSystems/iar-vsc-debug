;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;;
;; Part one of the system initialization code,
;; contains low-level
;; initialization.
;;

        MODULE  ?cstartup

        ;; Forward declaration of sections.
        SECTION	IRQ_STACK0:DATA:NOROOT(3)
        SECTION	FIQ_STACK0:DATA:NOROOT(3)
        SECTION	CSTACK0:DATA:NOROOT(3)
        SECTION	IRQ_STACK1:DATA:NOROOT(3)
        SECTION	FIQ_STACK1:DATA:NOROOT(3)
        SECTION	CSTACK1:DATA:NOROOT(3)

;
; The module in this file are included in the libraries, and may be
; replaced by any user-defined modules that define the PUBLIC symbol
; __iar_program_start or a user defined start symbol.
;
; To override the cstartup defined in the library, simply add your
; modified version to the workbench project.

        SECTION .intvec:CODE:NOROOT(2)

        PUBLIC  __vector
        PUBLIC  __iar_program_start
        EXTERN  Undefined_Handler
        EXTERN  getcoreid_imp
        EXTERN  Prefetch_Handler
        EXTERN  Abort_Handler
        EXTERN  FIQ_Handler
        EXTERN  INT_Handler
        EXTERN  global_semaphore

        DATA

__iar_init$$done:               ; The vector table is not needed
                                ; until after copy initialization is done

__vector:                       ; Make this a DATA label, so that stack usage
                                ; analysis doesn't consider it an uncalled fun

        ARM

        ; All default exception handlers (except reset) are
        ; defined as weak symbol definitions.
        ; If a handler is defined by the application it will take precedence.
        LDR     PC,Reset_Addr           ; Reset
        LDR     PC,Undefined_Addr       ; Undefined instructions
        LDR     PC,SWI_Addr             ; Software interrupt (SWI/SVC)
        LDR     PC,Prefetch_Addr        ; Prefetch abort
        LDR     PC,Abort_Addr           ; Data abort
        DCD     0                       ; RESERVED
        LDR     PC,IRQ_Addr             ; IRQ
        LDR     PC,FIQ_Addr             ; FIQ

        DATA

Reset_Addr:     DCD   __iar_program_start
Undefined_Addr: DCD   Undefined_Handler
SWI_Addr:       DCD   SWI_Handler
Prefetch_Addr:  DCD   Prefetch_Handler
Abort_Addr:     DCD   Abort_Handler
IRQ_Addr:       DCD   IRQ_Handler
FIQ_Addr:       DCD   FIQ_Handler


; --------------------------------------------------
; ?cstartup -- low-level system initialization code.
;
; After a reset execution starts here, the mode is ARM, supervisor
; with interrupts disabled.
;



        SECTION .text:CODE:NOROOT(2)

        EXTERN  __cmain
        EXTERN  main
        REQUIRE __vector
        EXTWEAK __iar_init_core
        EXTWEAK __iar_init_vfp

        ARM

T_bit   EQU    0x20                    ; Thumb bit (5) of CPSR/SPSR.
SWI_Handler:


  STMFD   sp!, {r0-r3, r12, lr}  ; Store registers
  MOV     r1, sp                 ; Set pointer to parameters
  MRS     r0, spsr               ; Get spsr
  STMFD   sp!, {r0, r3}          ; Store spsr onto stack and another
                                 ; register to maintain 8-byte-aligned stack
  TST     r0, #T_bit             ; Occurred in Thumb state?
  LDRNEH  r0, [lr,#-2]           ; Yes: Load halfword and...
  BICNE   r0, r0, #0xFF00        ; ...extract comment field
  LDREQ   r0, [lr,#-4]           ; No: Load word and...
  BICEQ   r0, r0, #0xFF000000    ; ...extract comment field

  ;;Call the correct SWI handler
  BLX    getcoreid_imp

  LDMFD   sp!, {r0, r3}          ; Get spsr from stack
  MSR     SPSR_cxsf, r0          ; Restore spsr
  LDMFD   sp!, {r0-r3, r12, pc}^ ; Restore registers and return

IRQ_Handler:
  PUSH  {r0-r3, r12, lr}
  BL    INT_Handler
  POP   {r0-r3, r12, lr}
  SUBS  pc, lr, #4

__iar_program_start:
?cstartup:

;
; Add initialization needed before setup of stackpointers here.
;

;
; Initialize the stack pointers.
; The pattern below can be used for any of the exception stacks:
; FIQ, IRQ, SVC, ABT, UND, SYS.
; The USR mode uses the same stack as SYS.
; The stack segments must be defined in the linker command file,
; and be declared above.
;


; --------------------
; Mode, correspords to bits 0-5 in CPSR

#define MODE_MSK 0x1F            ; Bit mask for mode bits in CPSR

#define USR_MODE 0x10            ; User mode
#define FIQ_MODE 0x11            ; Fast Interrupt Request mode
#define IRQ_MODE 0x12            ; Interrupt Request mode
#define SVC_MODE 0x13            ; Supervisor mode
#define ABT_MODE 0x17            ; Abort mode
#define UND_MODE 0x1B            ; Undefined Instruction mode
#define SYS_MODE 0x1F            ; System mode


        ;; Set vector table to on-chip RAM
        LDR     r0, =__vector
        MCR     p15, 0, r0, c12, c0, 0

        ;; Initialize semaphore to zero
        LDR     r0, =global_semaphore
        STR     r1, [r0]

        MOVS    r1, #0;
        MRS     r0, cpsr                ; Original PSR value

        MRC	p15, 0,	r1,	c0,	c0,	5	; Reading the MPIDR (core ID) to R1
        MOVS    r2, #0x3
        AND     r1, r1, r2
        MOVS    r2, #0
        CMP     r1,r2



        BNE     core1_setup

        core0_setup:

        ;; Set up the interrupt stack pointer.

        BIC     r0, r0, #MODE_MSK       ; Clear the mode bits
        ORR     r0, r0, #IRQ_MODE       ; Set IRQ mode bits
        MSR     cpsr_c, r0              ; Change the mode
        LDR     sp, =SFE(IRQ_STACK0)     ; End of IRQ_STACK
        BIC     sp,sp,#0x7              ; Make sure SP is 8 aligned

        ;; Set up the fast interrupt stack pointer.

        BIC     r0, r0, #MODE_MSK       ; Clear the mode bits
        ORR     r0, r0, #FIQ_MODE       ; Set FIR mode bits
        MSR     cpsr_c, r0              ; Change the mode
        LDR     sp, =SFE(FIQ_STACK0)     ; End of FIQ_STACK
        BIC     sp,sp,#0x7              ; Make sure SP is 8 aligned

        ;; Set up the normal stack pointer.

        BIC     r0 ,r0, #MODE_MSK       ; Clear the mode bits
        ORR     r0 ,r0, #SYS_MODE       ; Set System mode bits
        MSR     cpsr_c, r0              ; Change the mode
        LDR     sp, =SFE(CSTACK0)        ; End of CSTACK
        BIC     sp,sp,#0x7              ; Make sure SP is 8 aligned

        BL      init

        core1_setup:

        ;; Set up the interrupt stack pointer.

        BIC     r0, r0, #MODE_MSK       ; Clear the mode bits
        ORR     r0, r0, #IRQ_MODE       ; Set IRQ mode bits
        MSR     cpsr_c, r0              ; Change the mode
        LDR     sp, =SFE(IRQ_STACK1)     ; End of IRQ_STACK
        BIC     sp,sp,#0x7              ; Make sure SP is 8 aligned

        ;; Set up the fast interrupt stack pointer.

        BIC     r0, r0, #MODE_MSK       ; Clear the mode bits
        ORR     r0, r0, #FIQ_MODE       ; Set FIR mode bits
        MSR     cpsr_c, r0              ; Change the mode
        LDR     sp, =SFE(FIQ_STACK1)     ; End of FIQ_STACK
        BIC     sp,sp,#0x7              ; Make sure SP is 8 aligned

        ;; Set up the normal stack pointer.

        BIC     r0 ,r0, #MODE_MSK       ; Clear the mode bits
        ORR     r0 ,r0, #SYS_MODE       ; Set System mode bits
        MSR     cpsr_c, r0              ; Change the mode
        LDR     sp, =SFE(CSTACK1)        ; End of CSTACK
        BIC     sp,sp,#0x7              ; Make sure SP is 8 aligned

        init:

        ;; Turn on core features assumed to be enabled.
          FUNCALL __iar_program_start, __iar_init_core
        BL      __iar_init_core

        ;; Initialize VFP (if needed).
          FUNCALL __iar_program_start, __iar_init_vfp
        BL      __iar_init_vfp

        MOVS  R4, #0x1000
        CMP   r1, r2
        BNE   slave_wait

;;;
;;; Add more initialization here
;;;

;;; Continue to __cmain for C-level initialization.

        master_init:
          FUNCALL __iar_program_start, __cmain
        B       __cmain

        BL init_end

        ;; Slave waits for master to initialize variables
        slave_wait:

        LDR   r3, =global_semaphore
        LDR   r3, [r3]
        CMP   r3, r4
        BNE   slave_wait


          FUNCALL __iar_program_start, main
        BL main
        slave_exit:
        B slave_exit

        init_end:

        END


# Tutto l'addestramento, headless, con un solo comando: `make` (vedi runpod/README.md).
# I bersagli stanno in runpod/Makefile; questo file li inoltra dalla radice del repository.
.DEFAULT_GOAL := avvia
%:
	@$(MAKE) --no-print-directory -C runpod $@

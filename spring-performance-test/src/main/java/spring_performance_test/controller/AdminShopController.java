
package spring_performance_test.controller;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.validation.annotation.Validated;

import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.IntStream;

@Validated
@RestController
@RequestMapping("/api/admin/shops")
@Tag(name = "매장 관리", description = "관리자 매장 성능 테스트 API")
public class AdminShopController {

    private final ConcurrentHashMap<Long, ShopResponse> shopStore =
            new ConcurrentHashMap<>();

    private final AtomicLong sequence = new AtomicLong(0);

    public AdminShopController() {
        IntStream.rangeClosed(1, 100).forEach(i -> {
            long id = sequence.incrementAndGet();

            shopStore.put(id, new ShopResponse(
                    id,
                    "테스트 매장 " + id,
                    "서울",
                    true
            ));
        });
    }

    // 1. 목록 조회
    @GetMapping
    @Operation(summary = "매장 목록 조회")
    public ShopListResponse getShops(
            @Parameter(description = "페이지 번호") @RequestParam(defaultValue = "0") @Min(0) int page,
            @RequestParam(defaultValue = "10") @Min(1) @Max(100) int size,
            @RequestParam(required = false) String keyword
    ) {
        List<ShopResponse> filtered = shopStore.values()
                .stream()
                .filter(shop -> keyword == null ||
                        shop.name().contains(keyword))
                .sorted((a, b) -> Long.compare(a.id(), b.id()))
                .toList();

        List<ShopResponse> content = filtered.stream()
                .skip((long) page * size)
                .limit(size)
                .toList();

        return new ShopListResponse(
                content,
                page,
                size,
                filtered.size()
        );
    }

    // 2. 검색
    @GetMapping("/search")
    @Operation(summary = "매장 검색")
    public List<ShopResponse> searchShops(
            @RequestParam @NotBlank String keyword
    ) {
        return shopStore.values().stream()
                .filter(shop -> shop.name().contains(keyword))
                .toList();
    }

    // 3. 느린 API
    @GetMapping("/slow")
    @Operation(summary = "느린 API 테스트")
    public String slowApi(
            @RequestParam(defaultValue = "500")
            @Min(0) @Max(5000) int delay
    ) throws InterruptedException {

        Thread.sleep(delay);

        return "응답 지연: " + delay + "ms";
    }

    // 4. CPU 부하
    @GetMapping("/cpu")
    @Operation(summary = "CPU 부하 테스트")
    public double cpuTest(
            @RequestParam(defaultValue = "100000")
            @Min(1) @Max(10000000) int iterations
    ) {
        double result = 0;

        for (int i = 1; i <= iterations; i++) {
            result += Math.sqrt(i) * Math.sin(i);
        }

        return result;
    }

    // 5. 실패율 테스트
    @GetMapping("/error")
    @Operation(summary = "의도적인 HTTP 오류 테스트")
    public String errorTest(
            @RequestParam(defaultValue = "500") int status
    ) {
        if (status < 400 || status > 599) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST,
                    "400~599 사이 상태 코드를 입력하세요."
            );
        }

        throw new ResponseStatusException(
                HttpStatus.valueOf(status),
                "성능 테스트용 의도적인 오류"
        );
    }

    // 6. 단건 조회
    @GetMapping("/{id}")
    @Operation(summary = "매장 단건 조회")
    public ShopResponse getShop(@PathVariable Long id) {
        return findShop(id);
    }

    // 7. 매장 생성
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "매장 생성")
    public ShopResponse createShop(
            @Valid @RequestBody ShopCreateRequest request
    ) {
        long id = sequence.incrementAndGet();

        ShopResponse shop = new ShopResponse(
                id,
                request.name(),
                request.location(),
                true
        );

        shopStore.put(id, shop);

        return shop;
    }

    // 8. 매장 수정
    @PutMapping("/{id}")
    @Operation(summary = "매장 수정")
    public ShopResponse updateShop(
            @PathVariable Long id,
            @Valid @RequestBody ShopUpdateRequest request
    ) {
        return shopStore.compute(id, (key, existing) -> {
            if (existing == null) {
                throw new ResponseStatusException(
                        HttpStatus.NOT_FOUND,
                        "매장을 찾을 수 없습니다."
                );
            }

            return new ShopResponse(
                    id,
                    request.name(),
                    request.location(),
                    request.active()
            );
        });
    }

    // 9. 매장 삭제
    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Operation(summary = "매장 삭제")
    public void deleteShop(@PathVariable Long id) {
        ShopResponse removed = shopStore.remove(id);

        if (removed == null) {
            throw new ResponseStatusException(
                    HttpStatus.NOT_FOUND,
                    "매장을 찾을 수 없습니다."
            );
        }
    }

    private ShopResponse findShop(Long id) {
        ShopResponse shop = shopStore.get(id);

        if (shop == null) {
            throw new ResponseStatusException(
                    HttpStatus.NOT_FOUND,
                    "매장을 찾을 수 없습니다."
            );
        }

        return shop;
    }

    public record ShopCreateRequest(
            @NotBlank
            @Schema(
                    description = "매장 이름",
                    example = "테스트 매장"
            )
            String name,
            @NotBlank String location
    ) {}

    public record ShopUpdateRequest(
            @NotBlank String name,
            @NotBlank String location,
            @NotNull Boolean active
    ) {}

    public record ShopResponse(
            Long id,
            String name,
            String location,
            boolean active
    ) {}

    public record ShopListResponse(
            List<ShopResponse> content,
            int page,
            int size,
            int totalElements
    ) {}
}
